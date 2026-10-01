// A minimal JSON reader and writer for the kotiba-stt wire protocol.
//
// Deliberately hand-written rather than vendored. The protocol is flat objects of
// string / number / bool / null, plus one nested object on the way out (the language
// posterior), and pulling nlohmann or rapidjson into the build for that would add a
// second thing that has to be pinned, cached and audited on a runner nobody can log
// into. This is ~200 lines and it is the whole dependency surface outside whisper.cpp.
//
// It is a PARSER, not a validator: it accepts what a well-behaved client sends and
// refuses everything else with `ok() == false`. The host reports the refusal and stays
// alive — see the framing comment in main.cpp for why that is possible at all.

#ifndef KOTIBA_STT_JSON_H
#define KOTIBA_STT_JSON_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace kotiba {

// ---------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------

/// One flat JSON object. Values keep their source text so the caller can ask for the
/// type it expects rather than the type the sender happened to use.
class JsonObject {
 public:
  bool ok = false;
  std::string error;

  bool has(const std::string& key) const { return values_.count(key) > 0; }

  std::string string(const std::string& key, const std::string& fallback = "") const {
    auto it = values_.find(key);
    if (it == values_.end() || it->second.kind != Value::kString) return fallback;
    return it->second.text;
  }

  double number(const std::string& key, double fallback) const {
    auto it = values_.find(key);
    if (it == values_.end() || it->second.kind != Value::kNumber) return fallback;
    return it->second.number;
  }

  int64_t integer(const std::string& key, int64_t fallback) const {
    return static_cast<int64_t>(number(key, static_cast<double>(fallback)));
  }

  bool boolean(const std::string& key, bool fallback) const {
    auto it = values_.find(key);
    if (it == values_.end() || it->second.kind != Value::kBool) return fallback;
    return it->second.boolean;
  }

  /// True when the key is present and literally `null`. Distinct from absent, because
  /// `initialPrompt: null` (leave the field at nullptr) and `initialPrompt: ""` are
  /// different instructions to a decoder.
  bool isNull(const std::string& key) const {
    auto it = values_.find(key);
    return it != values_.end() && it->second.kind == Value::kNull;
  }

  static JsonObject parse(const std::string& text);

 private:
  struct Value {
    enum Kind { kString, kNumber, kBool, kNull } kind = kNull;
    std::string text;
    double number = 0;
    bool boolean = false;
  };
  std::map<std::string, Value> values_;
};

// ---------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------

/// Builds one line of JSON. Every response the host emits goes through this, so escaping
/// is written once — a transcript is arbitrary user speech and will contain quotes,
/// backslashes and, from whisper's own output, control characters.
class JsonWriter {
 public:
  JsonWriter() { out_ = "{"; }

  JsonWriter& key(const std::string& name) {
    comma();
    out_ += escape(name);
    out_ += ":";
    pendingComma_ = false;
    return *this;
  }

  JsonWriter& string(const std::string& name, const std::string& value) {
    key(name);
    out_ += escape(value);
    pendingComma_ = true;
    return *this;
  }

  JsonWriter& boolean(const std::string& name, bool value) {
    key(name);
    out_ += value ? "true" : "false";
    pendingComma_ = true;
    return *this;
  }

  JsonWriter& integer(const std::string& name, int64_t value) {
    key(name);
    out_ += std::to_string(value);
    pendingComma_ = true;
    return *this;
  }

  JsonWriter& number(const std::string& name, double value);

  /// A nested object of name → probability. The only nesting the protocol has.
  JsonWriter& posterior(const std::string& name,
                        const std::vector<std::pair<std::string, double>>& entries);

  /// A value that is already JSON — an array built by the caller from `JsonWriter`
  /// objects. kotiba-input's `audioSessions` is the one user; the caller owns its validity.
  JsonWriter& raw(const std::string& name, const std::string& json) {
    key(name);
    out_ += json;
    pendingComma_ = true;
    return *this;
  }

  std::string finish() {
    out_ += "}";
    return out_;
  }

  static std::string escape(const std::string& value);

 private:
  void comma() {
    if (pendingComma_) out_ += ",";
  }
  std::string out_;
  bool pendingComma_ = false;
};

}  // namespace kotiba

#endif  // KOTIBA_STT_JSON_H
