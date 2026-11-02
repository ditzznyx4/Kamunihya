const fs = require("fs");
const path = require("path");
const http = require("http");

// ===== Pengaturan =====
const MODEL = "claude-sonnet-4-6"; // 1 model saja, ganti di sini kalau perlu
const MAX_TOKENS = 4096;
const MAX_MESSAGES = 40; // batas riwayat chat yang dikirim ke model
const API_URL = "https://api.anthropic.com/v1/messages";

// API key diambil dari environment (diatur di vercel.json atau dashboard Vercel)
const API_KEY = () => process.env.ANTHROPIC_API_KEY;

// ===== File statis =====
const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
let HTML = "";
let SYSTEM_PROMPT = "";
try { HTML = read("chat-ai.html"); } catch (e) { console.error("chat-ai.html tidak ditemukan"); }
try { SYSTEM_PROMPT = read("chatbot-prompt.md"); } catch (e) { console.error("chatbot-prompt.md tidak ditemukan"); }

// ===== Util =====
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) return resolve(typeof req.body === "string" ? JSON.parse(req.body) : req.body);
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) { reject(new Error("Permintaan terlalu besar")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("JSON tidak valid")); } });
    req.on("error", reject);
  });
}

function cleanMessages(list) {
  if (!Array.isArray(list)) return [];
  const msgs = list
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }))
    .slice(-MAX_MESSAGES);
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // wajib diawali "user"
  return msgs;
}

// ===== Handler chat (streaming) =====
async function chat(req, res) {
  if (!API_KEY() || API_KEY().startsWith("isi-")) {
    return json(res, 500, { error: "API key belum diatur. Isi ANTHROPIC_API_KEY di vercel.json atau dashboard Vercel." });
  }

  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

  const messages = cleanMessages(body.messages);
  if (!messages.length) return json(res, 400, { error: "Pesan kosong." });

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        stream: true,
      }),
    });
  } catch (e) {
    return json(res, 502, { error: "Tidak bisa menghubungi layanan AI." });
  }

  if (!upstream.ok) {
    let detail = "";
    try { detail = (await upstream.json()).error?.message || ""; } catch {}
    const friendly = upstream.status === 401 ? "API key tidak valid." : upstream.status === 429 ? "Terlalu banyak permintaan. Coba lagi sebentar." : detail || "Layanan AI sedang bermasalah.";
    return json(res, upstream.status === 401 ? 500 : upstream.status, { error: friendly });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") res.write(evt.delta.text);
        } catch {}
      }
    }
  } catch (e) {
    // koneksi putus di tengah stream
  }
  res.end();
}

// ===== Router =====
async function handler(req, res) {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "POST" && url === "/api/chat") return chat(req, res);

  if (req.method === "GET" && (url === "/" || url === "/index.html" || url === "/chat-ai.html")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(HTML);
  }

  json(res, 404, { error: "Tidak ditemukan." });
}

module.exports = handler;

// Jalankan lokal: node index.js
if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () => console.log(`Aurelia berjalan di http://localhost:${port}`));
}
