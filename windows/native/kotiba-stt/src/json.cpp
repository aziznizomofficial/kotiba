#include "json.h"

#include <cmath>
#include <cstdio>

namespace kotiba {
namespace {

struct Cursor {
  const std::string& text;
  size_t at = 0;

  bool done() const { return at >= text.size(); }
  char peek() const { return at < text.size() ? text[at] : '\0'; }
  void skipSpace() {
    while (at < text.size()) {
      const char c = text[at];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++at;
      } else {
        break;
      }
    }
  }
};

/// Reads a JSON string literal, resolving the escapes the protocol can carry.
/// `\uXXXX` is decoded to UTF-8, including surrogate pairs — a vocabulary hint arrives
/// this way and Uzbek okina U+02BB is exactly the character a lazy decoder mangles.
bool readString(Cursor& c, std::string& out) {
  if (c.peek() != '"') return false;
  ++c.at;
  out.clear();
  while (!c.done()) {
    const char ch = c.text[c.at++];
    if (ch == '"') return true;
    if (ch != '\\') {
      out += ch;
      continue;
    }
    if (c.done()) return false;
    const char esc = c.text[c.at++];
    switch (esc) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        if (c.at + 4 > c.text.size()) return false;
        unsigned code = 0;
        if (std::sscanf(c.text.c_str() + c.at, "%4x", &code) != 1) return false;
        c.at += 4;
        // A high surrogate must be joined with its low partner before encoding, or the
        // character comes out as two replacement blobs.
        if (code >= 0xD800 && code <= 0xDBFF && c.at + 6 <= c.text.size() &&
            c.text[c.at] == '\\' && c.text[c.at + 1] == 'u') {
          unsigned low = 0;
          if (std::sscanf(c.text.c_str() + c.at + 2, "%4x", &low) == 1 && low >= 0xDC00 &&
              low <= 0xDFFF) {
            c.at += 6;
            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          }
        }
        if (code < 0x80) {
          out += static_cast<char>(code);
        } else if (code < 0x800) {
          out += static_cast<char>(0xC0 | (code >> 6));
          out += static_cast<char>(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
          out += static_cast<char>(0xE0 | (code >> 12));
          out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
          out += static_cast<char>(0x80 | (code & 0x3F));
        } else {
          out += static_cast<char>(0xF0 | (code >> 18));
          out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
          out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
          out += static_cast<char>(0x80 | (code & 0x3F));
        }
        break;
      }
      default:
        return false;
    }
  }
  return false;
}

/// Skips one value of any type, so an unexpected array or nested object in a request
/// costs that key and not the whole frame.
bool skipValue(Cursor& c);

bool skipContainer(Cursor& c, char open, char close) {
  if (c.peek() != open) return false;
  ++c.at;
  int depth = 1;
  while (!c.done() && depth > 0) {
    const char ch = c.peek();
    if (ch == '"') {
      std::string ignored;
      if (!readString(c, ignored)) return false;
      continue;
    }
    if (ch == open) ++depth;
    if (ch == close) --depth;
    ++c.at;
  }
  return depth == 0;
}

bool skipValue(Cursor& c) {
  c.skipSpace();
  const char ch = c.peek();
  if (ch == '"') {
    std::string ignored;
    return readString(c, ignored);
  }
  if (ch == '{') return skipContainer(c, '{', '}');
  if (ch == '[') return skipContainer(c, '[', ']');
  while (!c.done()) {
    const char n = c.peek();
    if (n == ',' || n == '}' || n == ']' || n == ' ' || n == '\n' || n == '\t' || n == '\r') break;
    ++c.at;
  }
  return true;
}

}  // namespace

JsonObject JsonObject::parse(const std::string& text) {
  JsonObject object;
  Cursor c{text};
  c.skipSpace();
  if (c.peek() != '{') {
    object.error = "the frame body is not a JSON object";
    return object;
  }
  ++c.at;
  c.skipSpace();
  if (c.peek() == '}') {
    object.ok = true;
    return object;
  }

  while (!c.done()) {
    c.skipSpace();
    std::string name;
    if (!readString(c, name)) {
      object.error = "expected a key";
      return object;
    }
    c.skipSpace();
    if (c.peek() != ':') {
      object.error = "expected ':' after key '" + name + "'";
      return object;
    }
    ++c.at;
    c.skipSpace();

    Value value;
    const char ch = c.peek();
    if (ch == '"') {
      if (!readString(c, value.text)) {
        object.error = "unterminated string for key '" + name + "'";
        return object;
      }
      value.kind = Value::kString;
    } else if (ch == 't' || ch == 'f') {
      value.kind = Value::kBool;
      value.boolean = (ch == 't');
      if (!skipValue(c)) {
        object.error = "malformed boolean for key '" + name + "'";
        return object;
      }
    } else if (ch == 'n') {
      value.kind = Value::kNull;
      if (!skipValue(c)) {
        object.error = "malformed null for key '" + name + "'";
        return object;
      }
    } else if (ch == '{' || ch == '[') {
      // Not part of the request shape. Kept as absent rather than refused, so a client
      // that sends an extra structured field does not lose the frame.
      value.kind = Value::kNull;
      if (!skipValue(c)) {
        object.error = "malformed container for key '" + name + "'";
        return object;
      }
    } else {
      const size_t start = c.at;
      if (!skipValue(c) || c.at == start) {
        object.error = "malformed number for key '" + name + "'";
        return object;
      }
      const std::string literal = text.substr(start, c.at - start);
      try {
        value.number = std::stod(literal);
      } catch (...) {
        object.error = "'" + literal + "' is not a number (key '" + name + "')";
        return object;
      }
      value.kind = Value::kNumber;
    }
    object.values_[name] = value;

    c.skipSpace();
    if (c.peek() == ',') {
      ++c.at;
      continue;
    }
    if (c.peek() == '}') {
      object.ok = true;
      return object;
    }
    object.error = "expected ',' or '}' after key '" + name + "'";
    return object;
  }
  object.error = "the JSON object is unterminated";
  return object;
}

std::string JsonWriter::escape(const std::string& value) {
  std::string out = "\"";
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (ch < 0x20) {
          // Control characters must be escaped or the line is not JSON. UTF-8 bytes
          // above 0x7F are passed through unchanged: the transcript is already UTF-8
          // and re-encoding it here is how an okina becomes a question mark.
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", ch);
          out += buffer;
        } else {
          out += static_cast<char>(ch);
        }
    }
  }
  out += "\"";
  return out;
}

JsonWriter& JsonWriter::number(const std::string& name, double value) {
  key(name);
  if (std::isfinite(value)) {
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%.6g", value);
    out_ += buffer;
  } else {
    // JSON has no NaN or Infinity. Emitting one produces a line the client cannot parse,
    // which reads as a dead host rather than a bad number.
    out_ += "null";
  }
  pendingComma_ = true;
  return *this;
}

JsonWriter& JsonWriter::posterior(const std::string& name,
                                  const std::vector<std::pair<std::string, double>>& entries) {
  key(name);
  out_ += "{";
  bool first = true;
  for (const auto& entry : entries) {
    if (!first) out_ += ",";
    first = false;
    out_ += escape(entry.first);
    out_ += ":";
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%.6g", entry.second);
    out_ += buffer;
  }
  out_ += "}";
  pendingComma_ = true;
  return *this;
}

}  // namespace kotiba
