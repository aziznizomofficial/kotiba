#!/usr/bin/env python3
"""Export the language-ID model the app runs (P4 §2, D-14) from SpeechBrain's checkpoint.

    pip install torch==2.14.0 speechbrain==1.1.1 coremltools==9.0 onnx==1.23.1 onnxruntime==1.30.0 soundfile
    python3 Scripts/export-ecapa.py OUT_DIR [--check clip.wav …]

Source: `speechbrain/lang-id-voxlingua107-ecapa` (Apache-2.0; trained on VoxLingua107, CC BY 4.0),
pinned to the revision below. Output, both from one PyTorch module — waveform (16 kHz mono
float32, 0.25–30 s) in, 107 log-posteriors out:

  * `ecapa-voxlingua107-lid-f16.mlmodel` — Core ML neural network, Float16 weights, one file
    (42.9 MB); the Mac app runs it on the CPU (`EcapaLanguageIdentifier`).
  * `ecapa-voxlingua107-lid.onnx` — ONNX opset 17, Float32 (82 MB); Windows runs it on
    onnxruntime (`windows/src/engines/language-id.ts`). Int8 dynamic quantisation was measured
    and refused: 59/60 argmax agreement and up to 0.40 of probability moved (P4 §2).

What the graph is: SpeechBrain's own Fbank front end, with the STFT written as a strided
convolution against the Hamming-windowed DFT basis (no FFT op, so Core ML and ONNX take it
as is); its 60-band filterbank (log, top_db 80); sentence mean normalisation; the ECAPA-TDNN;
the classifier, ending in log-softmax. Attentive statistics pooling runs without its length mask
(one utterance per call, so the mask is all ones). Checked against SpeechBrain's own
`classify_batch` on every `--check` clip: max |Δp| 1.2e-4 (Float32), 0.0018 (the Core ML
Float16 file, as the app runs it).
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import torch
import torch.nn.functional as F
from speechbrain.inference.classifiers import EncoderClassifier
from speechbrain.lobes.models import ECAPA_TDNN, Xvector
from speechbrain.processing.features import spectral_magnitude

REPO = "speechbrain/lang-id-voxlingua107-ecapa"
REVISION = "0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9"


def _pooling(self, x, lengths=None):
    def stats(x, m, dim=2, eps=self.eps):
        mean = (m * x).sum(dim)
        std = torch.sqrt((m * (x - mean.unsqueeze(dim)).pow(2)).sum(dim).clamp(eps))
        return mean, std
    if self.global_context:
        mean = x.mean(dim=2, keepdim=True)
        std = torch.sqrt((x - mean).pow(2).mean(dim=2, keepdim=True).clamp(self.eps))
        attn = torch.cat([x, mean.expand_as(x), std.expand_as(x)], dim=1)
    else:
        attn = x
    attn = F.softmax(self.conv(self.tanh(self.tdnn(attn))), dim=2)
    mean, std = stats(x, attn)
    return torch.cat((mean, std), dim=1).unsqueeze(2)


def _classifier(self, x):
    for name, layer in self.named_children():
        if name != "softmax":
            x = layer(x)
    return torch.log_softmax(x, dim=-1)


ECAPA_TDNN.AttentiveStatisticsPooling.forward = _pooling
Xvector.Classifier.forward = _classifier


def load(cache):
    from huggingface_hub import snapshot_download
    local = snapshot_download(REPO, revision=REVISION)
    return EncoderClassifier.from_hparams(source=local, savedir=cache, run_opts={"device": "cpu"},
                                          overrides={"pretrained_path": local})


class Lid(torch.nn.Module):
    def __init__(self, clf):
        super().__init__()
        stft = clf.mods.compute_features.compute_STFT
        assert stft.center and stft.pad_mode == "constant" and not stft.normalized_stft
        self.n_fft, self.hop = stft.n_fft, stft.hop_length
        win = stft.window.detach().float()
        k = torch.arange(self.n_fft // 2 + 1).float()[:, None]
        n = torch.arange(self.n_fft).float()[None, :]
        ang = 2 * np.pi * k * n / self.n_fft
        self.register_buffer("basis", torch.cat([torch.cos(ang) * win, -torch.sin(ang) * win], 0)[:, None, :])
        self.fb = clf.mods.compute_features.compute_fbanks
        self.emb = clf.mods.embedding_model
        self.cls = clf.mods.classifier

    def forward(self, wav):
        x = F.pad(wav[:, None, :], (self.n_fft // 2, self.n_fft // 2))
        spec = F.conv1d(x, self.basis, stride=self.hop)
        bins = self.n_fft // 2 + 1
        st = torch.stack([spec[:, :bins], spec[:, bins:]], -1).transpose(1, 2)
        feats = self.fb(spectral_magnitude(st))
        feats = feats - feats.mean(dim=1, keepdim=True)
        return self.cls(self.emb(feats))[:, 0, :]


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    clf = load(os.path.join(out, "speechbrain-cache"))
    clf.eval()
    model = Lid(clf).eval()
    labels = [clf.hparams.label_encoder.ind2lab[i].split(":")[0] for i in range(107)]
    json.dump(labels, open(os.path.join(out, "ecapa-labels.json"), "w"))

    import coremltools as ct
    from coremltools.models.neural_network import quantization_utils
    traced = torch.jit.trace(model, torch.zeros(1, 48000))
    ml = ct.convert(traced, inputs=[ct.TensorType(name="audio", shape=(1, ct.RangeDim(4000, 480000, default=48000)))],
                    outputs=[ct.TensorType(name="logp")], convert_to="neuralnetwork")
    ml = quantization_utils.quantize_weights(ml, nbits=16)
    ml.short_description = "SpeechBrain VoxLingua107 ECAPA-TDNN language ID (Apache-2.0), waveform to 107 log-posteriors"
    ml.save(os.path.join(out, "ecapa-voxlingua107-lid-f16.mlmodel"))
    torch.onnx.export(model, torch.zeros(1, 48000), os.path.join(out, "ecapa-voxlingua107-lid.onnx"),
                      input_names=["audio"], output_names=["logp"], dynamic_axes={"audio": {1: "samples"}},
                      opset_version=17, dynamo=False)

    if "--check" in sys.argv:
        import soundfile as sf
        import onnxruntime as ort
        session = ort.InferenceSession(os.path.join(out, "ecapa-voxlingua107-lid.onnx"))
        worst = 0.0
        for path in sys.argv[sys.argv.index("--check") + 1:]:
            x, _ = sf.read(path, dtype="float32")
            with torch.no_grad():
                ref = torch.softmax(clf.classify_batch(torch.from_numpy(x)[None])[0].reshape(1, -1), -1).numpy()
            got = np.exp(session.run(None, {"audio": x[None]})[0])
            worst = max(worst, float(np.abs(got - ref).max()))
        print(f"onnx against SpeechBrain: max |Δp| {worst:.2e}")
    for name in ("ecapa-voxlingua107-lid-f16.mlmodel", "ecapa-voxlingua107-lid.onnx"):
        p = os.path.join(out, name)
        import hashlib
        print(name, os.path.getsize(p), hashlib.sha256(open(p, "rb").read()).hexdigest())


if __name__ == "__main__":
    main()
