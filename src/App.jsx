import React, { useState, useRef } from "react";

// Small bencode parser that returns raw byte ranges for values so we can compute the info-hash.
function parseBencode(u8) {
  let pos = 0;
  const textDecoder = new TextDecoder("utf-8");

  function parseNumber() {
    const start = pos;
    while (u8[pos] !== 0x65) {
      // 'e'
      pos++;
      if (pos >= u8.length)
        throw new Error("Unexpected end while parsing number");
    }
    const str = textDecoder.decode(u8.slice(start, pos));
    pos++; // skip 'e'
    return Number(str);
  }

  function parseIntUntil(delim) {
    const start = pos;
    while (u8[pos] !== delim) {
      pos++;
      if (pos >= u8.length)
        throw new Error("Unexpected end while parsing intUntil");
    }
    const num = Number(textDecoder.decode(u8.slice(start, pos)));
    pos++; // skip delim
    return num;
  }

  function parseValue() {
    const token = u8[pos];
    if (token === 0x64) {
      // 'd'
      const startRaw = pos;
      pos++; // skip 'd'
      const obj = {};
      while (u8[pos] !== 0x65) {
        // until 'e'
        const keyRes = parseString();
        const key = keyRes.value;
        const valRes = parseValue();
        obj[key] = valRes.value;
        // store raw of value if key === 'info'
        if (key === "info") {
          obj.__info_raw = u8.slice(valRes.rawStart, valRes.rawEnd);
        }
      }
      pos++; // skip 'e'
      const endRaw = pos;
      return { value: obj, rawStart: startRaw, rawEnd: endRaw };
    } else if (token === 0x6c) {
      // 'l'
      const startRaw = pos;
      pos++;
      const arr = [];
      while (u8[pos] !== 0x65) {
        const r = parseValue();
        arr.push(r.value);
      }
      pos++; // skip 'e'
      const endRaw = pos;
      return { value: arr, rawStart: startRaw, rawEnd: endRaw };
    } else if (token === 0x69) {
      // 'i'
      pos++; // skip 'i'
      const numStart = pos;
      while (u8[pos] !== 0x65) pos++;
      const num = Number(textDecoder.decode(u8.slice(numStart, pos)));
      pos++; // skip 'e'
      return { value: num, rawStart: numStart - 1, rawEnd: pos };
    } else if (token >= 0x30 && token <= 0x39) {
      // '0'-'9' => string length
      return parseString();
    } else {
      throw new Error("Unknown token at pos " + pos + ": " + token);
    }
  }

  function parseString() {
    const lenStart = pos;
    // read digits until ':'
    while (u8[pos] !== 0x3a) pos++;
    const len = Number(textDecoder.decode(u8.slice(lenStart, pos)));
    pos++; // skip ':'
    const sStart = pos;
    const sEnd = pos + len;
    if (sEnd > u8.length)
      throw new Error("Unexpected end while parsing string");
    const str = textDecoder.decode(u8.slice(sStart, sEnd));
    pos = sEnd;
    return { value: str, rawStart: lenStart, rawEnd: sEnd };
  }

  const result = parseValue();
  return result;
}

async function sha1Hex(arrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-1", arrayBuffer);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function App() {
  const [magnet, setMagnet] = useState("");
  const [torrentName, setTorrentName] = useState("");
  const [error, setError] = useState("");
  const [rawInfoHash, setRawInfoHash] = useState("");
  const fileInputRef = useRef(null);
  const [processing, setProcessing] = useState(false);

  async function handleFile(file) {
    setError("");
    setMagnet("");
    setProcessing(true);
    try {
      const ab = await file.arrayBuffer();
      const u8 = new Uint8Array(ab);
      const parsed = parseBencode(u8);
      // parsed.value is the top-level dict
      const top = parsed.value;
      // ensure info raw is present
      let infoRaw = null;
      if (top && top.__info_raw) infoRaw = top.__info_raw;
      else if (parsed.value && parsed.value.info && parsed.value.__info_raw)
        infoRaw = parsed.value.__info_raw;
      else {
        // try walking to find info_raw in nested structure
        // but normally top-level dict has 'info'
      }

      if (!infoRaw) {
        // attempt manual scan to find '4:info' and then parse the value from that position
        // fallback: find the literal bytes `4:info` in u8 and try parse
        const needle = new TextEncoder().encode("4:info");
        let found = -1;
        for (let i = 0; i + needle.length <= u8.length; i++) {
          let ok = true;
          for (let j = 0; j < needle.length; j++)
            if (u8[i + j] !== needle[j]) {
              ok = false;
              break;
            }
          if (ok) {
            found = i;
            break;
          }
        }
        if (found !== -1) {
          // position after '4:info' is found + 6
          const valueStart = found + needle.length;
          // parse value starting from valueStart
          // reuse parse logic by slicing
          const slice = u8.slice(valueStart);
          try {
            const res = parseBencode(slice);
            // res.rawStart is relative to slice, compute absolute
            const absStart = valueStart + res.rawStart;
            const absEnd = valueStart + res.rawEnd;
            infoRaw = u8.slice(absStart, absEnd);
          } catch (e) {
            // ignore
          }
        }
      }

      if (!infoRaw)
        throw new Error("Could not locate info dictionary in torrent");

      // compute sha1 of the raw bencoded info dict
      const hex = await sha1Hex(infoRaw.buffer);
      setRawInfoHash(hex);

      // build magnet link (using hex infohash). include torrent name if present
      const dn =
        top && top["name"]
          ? encodeURIComponent(top["name"])
          : encodeURIComponent(file.name.replace(/\.torrent$/i, ""));
      const magnetLink = `magnet:?xt=urn:btih:${hex}&dn=${dn}`;
      setTorrentName(dn);
      setMagnet(magnetLink);
    } catch (e) {
      console.error(e);
      setError(String(e.message || e));
    } finally {
      setProcessing(false);
    }
  }

  function onInputChange(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    handleFile(f);
  }

  function onDrop(e) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }

  function onDragOver(e) {
    e.preventDefault();
  }

  async function copyMagnet() {
    if (!magnet) return;
    try {
      await navigator.clipboard.writeText(magnet);
      alert("Magnet link copied to clipboard");
    } catch (e) {
      setError("Copy failed: " + e.message);
    }
  }

  return (
    <div className="d-flex">
      <div
        style={{
          fontFamily: "Inter, Roboto, system-ui, -apple-system, sans-serif",
          padding: 24,
          maxWidth: 900,
          margin: "0 auto",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Torrent → Magnet</h1>
        <p style={{ marginTop: 0, color: "#555" }}>
          Upload a <strong>.torrent</strong> file (drag & drop or file picker)
          and this app will extract the magnet link (info-hash).
        </p>

        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          style={{
            border: "2px dashed #ccc",
            borderRadius: 12,
            padding: 28,
            textAlign: "center",
            marginTop: 12,
            cursor: "pointer",
            background: "#fafafa",
          }}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".torrent"
            style={{ display: "none" }}
            onChange={onInputChange}
          />
          <div style={{ fontSize: 14, color: "#333" }}>
            {processing
              ? "Processing..."
              : "Drag a .torrent file here or click to choose"}
          </div>
          <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
            Supported: standard .torrent files. No upload to server — everything
            happens locally in your browser.
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: 16,
              color: "white",
              background: "#c0392b",
              padding: 10,
              borderRadius: 8,
            }}
          >
            {error}
          </div>
        )}

        {magnet && (
          <div
            style={{
              marginTop: 18,
              padding: 12,
              borderRadius: 8,
              background: "#eef6ff",
              border: "1px solid #cfe6ff",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: "#333" }}>Name</div>
                <div style={{ fontWeight: 600 }}>
                  {decodeURIComponent(torrentName)}
                </div>
              </div>
              <div>
                <button
                  onClick={copyMagnet}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Copy Magnet
                </button>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, color: "#333" }}>Magnet</div>
              <textarea
                readOnly
                value={magnet}
                style={{
                  width: "100%",
                  height: 88,
                  marginTop: 6,
                  padding: 8,
                  borderRadius: 6,
                }}
              />
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#444" }}>
              Info-hash (hex):{" "}
              <code
                style={{
                  background: "#fff",
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                {rawInfoHash}
              </code>
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, fontSize: 12, color: "#666" }}>
          Note: This app computes the SHA-1 of the raw bencoded{" "}
          <code>info</code> dictionary from the torrent file — the resulting hex
          is used as the btih in the magnet link. It runs entirely in your
          browser; no files are uploaded to any server.
        </div>
      </div>
    </div>
  );
}
