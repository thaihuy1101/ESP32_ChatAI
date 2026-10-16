// ==============================================================================
// CLOUDFLARE WORKER: ESP32-S3 FULL-DUPLEX AI BACKEND
// - Cloudflare KV CHAT_HISTORY: Lưu tối đa 6 câu đối thoại gần nhất
// - TTS CHÍNH: Microsoft Edge Neural TTS - Giọng HOÀI MY (vi-VN-HoaiMyNeural)
// - Thời gian thực: Múi giờ Việt Nam GMT+7 (Asia/Ho_Chi_Minh)
// - Thời tiết thực tế: Open-Meteo API (Mặc định Biên Hòa, Đồng Nai + tra cứu tỉnh thành)
// - Kho nhạc Việt: V-Pop Hits, Lofi Chill Việt, Trữ Tình Bolero, Vinahouse/EDM, Piano, Sài Gòn Radio
// - Fix đọc lắp bắp: Đồng bộ thời lượng âm thanh (audio duration pacing), triệt tiêu ngắt quãng
// - Giao thức hỗ trợ: Chuẩn Xiaozhi WebSocket (/ws), HTTP REST (/chat, /tts, /music, /test_chat)
// ==============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --------------------------------------------------------------------------
    // CỔNG 1: WEBSOCKET FULL-DUPLEX (/ws) - XIAOZHI STREAMING ARCHITECTURE
    // --------------------------------------------------------------------------
    if (url.pathname === "/ws" || request.headers.get("Upgrade") === "websocket") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }

      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      server.accept();
      handleWebSocketSession(server, env, ctx, request);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // --------------------------------------------------------------------------
    // CỔNG 2: HTTP GET /music - PROXY STREAM KHO NHẠC VIỆT CHO ESP32
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/music") {
      const type = (url.searchParams.get("type") || "vpop").toLowerCase();
      let targetUrl = "https://stream.zeno.fm/0r0xa792kwzuv"; // Mặc định V-Pop

      if (type === "lofi" || type === "chill") {
        targetUrl = "https://stream.zeno.fm/f3wvbbqmdg8uv";
      } else if (type === "bolero" || type === "lovesongs" || type === "trutinh") {
        targetUrl = "http://listen.57fm.com/lscafe";
      } else if (type === "remix" || type === "vinahouse" || type === "dance") {
        targetUrl = "https://streams.ilovemusic.de/iloveradio17.mp3";
      } else if (type === "piano" || type === "relax") {
        targetUrl = "https://streams.ilovemusic.de/iloveradio26.mp3";
      } else if (type === "saigon" || type === "radio") {
        targetUrl = "https://stream.zeno.fm/jxniabwipmhtv";
      } else if (type === "cherry" || type === "top100") {
        targetUrl = "https://stream.zeno.fm/umt5gqmg3reuv";
      }

      try {
        const streamRes = await fetch(targetUrl, {
          headers: { "User-Agent": "ESP8266Audio" }
        });

        return new Response(streamRes.body, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response("Stream error: " + err.message, { status: 502 });
      }
    }

    // --------------------------------------------------------------------------
    // CỔNG 3: HTTP GET /tts - HOÀI MY NEURAL TTS (FALLBACK GOOGLE TTS)
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/tts") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing text parameter", { status: 400 });

      // Ưu tiên Edge TTS Hoài My Neural MP3
      try {
        const mp3Buffer = await fetchEdgeTTS(text, "vi-VN-HoaiMyNeural", "+0%", "audio-24khz-48kbitrate-mono-mp3");
        return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
      } catch (e) {
        console.warn("[TTS] Hoai My failed, fallback to Google TTS:", e.message);
      }

      // Dự phòng Google TTS
      try {
        const mp3Buffer = await fetchGoogleTTS(text);
        return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
      } catch (e) {
        return new Response("TTS Failed: " + e.message, { status: 500 });
      }
    }

    // --------------------------------------------------------------------------
    // CỔNG 4: HTTP POST /chat - REST STT + LLM (TƯƠNG THÍCH BẢN CŨ)
    // --------------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/chat") {
      const GROQ_API_KEY = env.GROQ_API_KEY;

      try {
        const audioBuffer = await request.arrayBuffer();
        
        const formData = new FormData();
        formData.append("file", new File([audioBuffer], "audio.wav", { type: "audio/wav" }));
        formData.append("model", "whisper-large-v3-turbo"); 
        formData.append("language", "vi");
        formData.append("response_format", "json");
        formData.append("temperature", "0");
        formData.append("prompt", "Hội thoại hỏi đáp trực tiếp tiếng Việt đời thường, kiến thức khoa học, tuyệt đối không có quảng cáo YouTube.");

        const sttResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: formData
        });

        if (!sttResponse.ok) {
          throw new Error("STT Failed");
        }
        const sttData = await sttResponse.json();
        const userText = (sttData.text || "").trim();

        if (!userText) return new Response(JSON.stringify({ error: "No speech" }), { status: 400 });

        if (isWhisperHallucination(userText)) {
          return new Response(JSON.stringify({ error: "Hallucination filtered", no_speech: true }), { status: 400 });
        }

        const weatherContext = await getDetailedWeatherAndContext(userText);
        const timeContext = getRealTimeContext();

        const matchMusic = detectMusicIntent(userText);
        let musicUrl = "";
        if (matchMusic.isMusic) {
          musicUrl = `${url.origin}/music?type=${matchMusic.type}`;
        }

        const msgList = [
          {
            role: "system",
            content: `Bạn là trợ lý AI thông minh, hiểu biết sâu rộng, thân thiện và gần gũi.
QUY TẮC XƯNG HÔ: Luôn xưng là "tôi" và gọi người dùng là "bạn" (tuyệt đối không xưng em, không gọi anh/chị, không dùng dạ/thưa).
THỜI GIAN THỰC TẾ: Bây giờ là ${timeContext.time}, ${timeContext.date}.
VỊ TRÍ & THỜI TIẾT: ${weatherContext}
PHONG CÁCH TRẢ LỜI: Hãy trả lời tự nhiên, thân thiện và súc tích (khoảng 2 đến 3 câu, dưới 50 từ) phù hợp với đàm thoại giọng nói qua loa thông minh. Không dùng ký tự markdown như *, #, gạch đầu dòng.`
          },
          { role: "user", content: userText }
        ];

        const llmResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "qwen/qwen3.8-27b",
            messages: msgList,
            temperature: 0.7,
            max_tokens: 160
          })
        });

        if (!llmResponse.ok) throw new Error("LLM Failed");

        const llmData = await llmResponse.json();
        let aiText = llmData.choices[0].message.content.trim();
        if (!aiText) aiText = matchMusic.isMusic ? `Tôi đang mở ${matchMusic.title} cho bạn đây, chúc bạn nghe vui vẻ!` : "Tôi không có câu trả lời.";
        aiText = aiText.replace(/[*_#~]/g, '');

        const isExit = isExitCommand(userText);

        return new Response(JSON.stringify({
          user: userText,
          text: aiText,
          user_text: userText,
          ai_text: aiText,
          emotion: "happy",
          music_url: musicUrl,
          exit: isExit
        }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // --------------------------------------------------------------------------
    // CỔNG 5: TEST STATUS ENDPOINT
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/test_chat") {
      const timeInfo = getRealTimeContext();
      return new Response(`ESP32 AI Backend & WebSocket /ws is ready!\nThời gian: ${timeInfo.time}, ${timeInfo.date}\nTTS: Hoai My Neural (vi-VN)\nKV CHAT_HISTORY: ${env.CHAT_HISTORY ? "CONNECTED" : "NOT BOUND"}`, { status: 200 });
    }

    return new Response("ESP32 AI Backend Active! WebSocket: /ws, TTS: Hoai My Neural, KV: CHAT_HISTORY.", { status: 200 });
  }
};

// ==============================================================================
// XỬ LÝ PHIÊN WEBSOCKET CHO ESP32-S3 (XIAOZHI FULL-DUPLEX PROTOCOL)
// ==============================================================================
async function handleWebSocketSession(server, env, ctx, initialRequest) {
  let audioChunks = []; // Lưu trữ chunks (PCM hoặc Opus)
  let isProcessing = false;
  let abortController = null;
  let conversationHistory = [];
  let isXiaozhiClient = false;
  let sessionId = "session_" + Date.now();
  let silenceTimer = null;
  let hasVoiceActivity = false;
  let voicePacketsCount = 0;
  let silencePacketsCount = 0;

  // Xác định định danh thiết bị để gắn lịch sử trò chuyện KV
  const deviceId = initialRequest.headers.get("Device-Id") || initialRequest.headers.get("Client-Id") || "default_esp32";
  const historyKey = `chat_history_${deviceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // Tải lịch sử 6 câu gần nhất từ Cloudflare KV CHAT_HISTORY khi kết nối
  if (env.CHAT_HISTORY) {
    try {
      const savedHistory = await env.CHAT_HISTORY.get(historyKey, "json");
      if (Array.isArray(savedHistory)) {
        conversationHistory = savedHistory.slice(-6);
        console.log(`[KV] Đã tải ${conversationHistory.length} câu lịch sử cho ${historyKey}`);
      }
    } catch (e) {
      console.warn("[KV] Lỗi tải lịch sử trò chuyện:", e.message);
    }
  }

  const sendJSON = (obj) => {
    try {
      server.send(JSON.stringify(obj));
    } catch (e) {}
  };

  const sendBinary = (data) => {
    try {
      server.send(data);
    } catch (e) {}
  };

  const finishAndProcessAudio = async () => {
    if (isProcessing) return;
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    // Kiểm tra nếu đoạn âm thanh quá ngắn (dưới 8 gói ~ 0.5s)
    if (audioChunks.length < 8) {
      audioChunks = [];
      hasVoiceActivity = false;
      sendJSON({ type: "state", state: "listening" });
      return;
    }

    isProcessing = true;
    hasVoiceActivity = false;
    abortController = new AbortController();
    const signal = abortController.signal;

    sendJSON({ type: "state", state: "thinking" });

    try {
      // 1. Chuẩn bị file Audio gửi tới Groq Whisper
      let audioBlobFile;
      if (isXiaozhiClient) {
        const oggBuffer = opusPacketsToOgg(audioChunks, 16000);
        audioChunks = [];
        audioBlobFile = new File([oggBuffer], "audio.ogg", { type: "audio/ogg" });
      } else {
        let totalLength = 0;
        for (const chunk of audioChunks) totalLength += chunk.byteLength;
        const fullPcm = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunks) {
          fullPcm.set(chunk, offset);
          offset += chunk.byteLength;
        }
        audioChunks = [];
        const wavBuffer = pcmToWav(fullPcm.buffer, 16000, 1, 16);
        audioBlobFile = new File([wavBuffer], "audio.wav", { type: "audio/wav" });
      }

      // 2. Groq Whisper STT Siêu Tốc
      const formData = new FormData();
      formData.append("file", audioBlobFile);
      formData.append("model", "whisper-large-v3-turbo");
      formData.append("language", "vi");
      formData.append("response_format", "json");
      formData.append("temperature", "0");
      formData.append("prompt", "Hội thoại hỏi đáp trực tiếp tiếng Việt, giao tiếp trợ lý ảo đời thường, tuyệt đối không có quảng cáo YouTube.");

      const sttRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` },
        body: formData,
        signal
      });

      if (!sttRes.ok) throw new Error("STT Failed");
      const sttData = await sttRes.json();
      const userText = (sttData.text || "").trim();

      if (!userText || signal.aborted) {
        sendJSON({ type: "state", state: "listening" });
        isProcessing = false;
        return;
      }

      // Lọc ảo giác Whisper trước khi in ra màn hình
      if (isWhisperHallucination(userText)) {
        console.log("[Whisper Hallucination Filtered]:", userText);
        sendJSON({ type: "state", state: "listening" });
        isProcessing = false;
        return;
      }

      // Gửi kết quả nhận diện giọng nói về màn hình ESP32
      sendJSON({ type: "stt", text: userText });

      const lowerUser = userText.toLowerCase().replace(/[.,!?]/g, '').trim();

      // A. KIỂM TRA LỆNH XÓA LỊCH SỬ TRÒ CHUYỆN
      const isClearHistory = ["xóa lịch sử", "xoa lich su", "quên lịch sử", "quen lich su", "reset lịch sử", "xóa bộ nhớ", "xoa bo nho"].some(w => lowerUser.includes(w));
      if (isClearHistory) {
        conversationHistory = [];
        if (env.CHAT_HISTORY) {
          ctx.waitUntil(env.CHAT_HISTORY.delete(historyKey).catch(e => console.error(e)));
        }
        const confirmClear = "Tôi đã xóa toàn bộ lịch sử trò chuyện rồi bạn nhé.";
        sendJSON({ type: "tts", state: "start" });
        sendJSON({ type: "state", state: "speaking" });
        await speakWithPacing(confirmClear, sendJSON, sendBinary, signal);
        sendJSON({ type: "tts", state: "stop" });
        sendJSON({ type: "state", state: "listening" });
        isProcessing = false;
        return;
      }

      // B. KIỂM TRA LỆNH TẮT NHẠC / DỪNG NHẠC
      const stopMusicKeywords = ["tắt nhạc", "tat nhac", "dừng nhạc", "dung nhac", "ngừng nhạc", "ngung nhac", "dừng phát nhạc"];
      if (stopMusicKeywords.some(w => lowerUser.includes(w))) {
        sendJSON({ type: "music", action: "stop" });
        sendJSON({ type: "tts", state: "start" });
        sendJSON({ type: "state", state: "speaking" });
        await speakWithPacing("Tôi đã tắt nhạc rồi bạn nhé.", sendJSON, sendBinary, signal);
        sendJSON({ type: "tts", state: "stop" });
        sendJSON({ type: "state", state: "listening" });
        isProcessing = false;
        return;
      }

      // C. KIỂM TRA YÊU CẦU MỞ NHẠC (KHO NHẠC VIỆT)
      const musicIntent = detectMusicIntent(userText);
      if (musicIntent.isMusic) {
        const workerOrigin = new URL(initialRequest.url).origin;
        const targetStreamUrl = `${workerOrigin}/music?type=${musicIntent.type}`;
        const confirmText = `Tôi đang mở ${musicIntent.title} cho bạn đây, chúc bạn nghe vui vẻ nhé!`;

        sendJSON({ type: "tts", state: "start" });
        sendJSON({ type: "state", state: "speaking" });
        
        // Đọc câu thông báo đầy đủ với duration pacing
        await speakWithPacing(confirmText, sendJSON, sendBinary, signal);
        
        sendJSON({ type: "tts", state: "stop" });

        // Gửi lệnh phát nhạc cho MusicPlayer trên ESP32
        sendJSON({
          type: "music",
          action: "play",
          title: musicIntent.title,
          url: targetStreamUrl
        });

        sendJSON({
          type: "done",
          user_text: userText,
          ai_text: confirmText,
          exit: false
        });

        isProcessing = false;
        return;
      }

      // D. KIỂM TRA CÂU THOÁT / TẠM BIỆT
      const isExit = isExitCommand(userText);

      // E. TRÒ CHUYỆN AI VỚI GROQ LLM (Qwen) + REAL-TIME CLOCK + OPEN-METEO WEATHER
      sendJSON({ type: "tts", state: "start" });
      sendJSON({ type: "state", state: "speaking" });

      const weatherContext = await getDetailedWeatherAndContext(userText);
      const timeContext = getRealTimeContext();

      const systemPrompt = `Bạn là trợ lý ảo AI thông minh, vui vẻ và tự nhiên.
QUY TẮC XƯNG HÔ: Luôn xưng "tôi" và gọi người dùng là "bạn" (tuyệt đối không xưng em, không gọi anh/chị, không dùng dạ/thưa).
THỜI GIAN THỰC TẾ: Bây giờ là ${timeContext.time}, ${timeContext.date}.
VỊ TRÍ & THỜI TIẾT: ${weatherContext}
HƯỚNG DẪN TRẢ LỜI: Hãy trả lời ngắn gọn, cô đọng từ 1 đến 3 câu (dưới 45 từ) nói thẳng vào trọng tâm câu hỏi để đàm thoại mượt mà qua loa thông minh. Tuyệt đối không dùng ký tự markdown như *, #, gạch đầu dòng.`;

      // Cắt gọn lịch sử: tối đa 6 câu gần nhất
      const historyContext = conversationHistory.slice(-6);

      const messages = [
        { role: "system", content: systemPrompt },
        ...historyContext,
        { role: "user", content: userText }
      ];

      const llmRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b",
          messages: messages,
          temperature: 0.7,
          max_tokens: 160
        }),
        signal
      });

      if (!llmRes.ok) throw new Error("LLM Failed");

      const llmData = await llmRes.json();
      let aiText = (llmData.choices?.[0]?.message?.content || "").trim();
      aiText = aiText.replace(/[*_#~]/g, '').trim();

      if (!aiText) aiText = "Tôi đang lắng nghe bạn đây.";

      // F. TỔNG HỢP GIỌNG ĐỌC HOÀI MY NEURAL VÀ PHÁT VỚI DURATION PACING
      await speakWithPacing(aiText, sendJSON, sendBinary, signal);

      // G. LƯU LỊCH SỬ VÀO CLOUDFLARE KV CHAT_HISTORY (TỐI ĐA 6 CÂU)
      if (!signal.aborted && aiText) {
        conversationHistory.push({ role: "user", content: userText });
        conversationHistory.push({ role: "assistant", content: aiText });
        if (conversationHistory.length > 6) {
          conversationHistory = conversationHistory.slice(-6);
        }

        if (env.CHAT_HISTORY) {
          ctx.waitUntil(
            env.CHAT_HISTORY.put(historyKey, JSON.stringify(conversationHistory), {
              expirationTtl: 86400 * 30 // Giữ 30 ngày
            }).catch(e => console.error("[KV] Lưu lịch sử thất bại:", e))
          );
        }
      }

      sendJSON({ type: "tts", state: "stop" });
      sendJSON({
        type: "done",
        user_text: userText,
        ai_text: aiText,
        exit: isExit
      });

      if (isExit) {
        sendJSON({ type: "goodbye" });
      }

    } catch (err) {
      if (!signal.aborted) {
        console.error("[WS Error]:", err.message);
        sendJSON({ type: "error", message: err.message });
        sendJSON({ type: "tts", state: "stop" });
        sendJSON({ type: "state", state: "listening" });
      }
    } finally {
      isProcessing = false;
      abortController = null;
      hasVoiceActivity = false;
    }
  };

  // Keep-alive ping gửi định kỳ mỗi 25s
  const pingInterval = setInterval(() => {
    try {
      sendJSON({ type: "ping" });
    } catch (e) {}
  }, 25000);

  server.addEventListener("message", async (event) => {
    // 1. DỮ LIỆU NHỊ PHÂN: AUDIO PACKETS TỪ MICRO (OPUS HOẶC PCM)
    if (event.data instanceof ArrayBuffer) {
      if (isProcessing) return;
      if (event.data.byteLength > 0) {
        audioChunks.push(new Uint8Array(event.data));

        // Gói Opus tiếng nói thường có dung lượng > 75 bytes
        const isVoice = event.data.byteLength >= 75;

        if (isVoice) {
          voicePacketsCount++;
          silencePacketsCount = 0;
          hasVoiceActivity = true;
        } else {
          if (hasVoiceActivity && voicePacketsCount >= 4) {
            silencePacketsCount++;
            // 12 gói yên lặng liên tiếp sau khi nói = 12 * 60ms = 720ms -> Người dùng đã nói xong!
            if (silencePacketsCount >= 12) {
              voicePacketsCount = 0;
              silencePacketsCount = 0;
              finishAndProcessAudio();
              return;
            }
          }
        }

        // Giới hạn tối đa 7s nói liên tục (~120 gói * 60ms)
        if (audioChunks.length >= 120) {
          voicePacketsCount = 0;
          silencePacketsCount = 0;
          finishAndProcessAudio();
        }
      }
      return;
    }

    // 2. DỮ LIỆU TEXT / JSON CONTROL PACKETS
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);

        // A. BẮT TAY GIAO THỨC XIAOZHI (HELLO)
        if (msg.type === "hello") {
          isXiaozhiClient = true;
          if (msg.session_id) sessionId = msg.session_id;

          sendJSON({
            type: "hello",
            transport: "websocket",
            session_id: sessionId,
            audio_params: {
              format: "opus",
              sample_rate: 16000,
              channels: 1,
              frame_duration: 60
            }
          });
          return;
        }

        // B. KEEP-ALIVE PING / PONG
        if (msg.type === "ping") {
          sendJSON({ type: "pong", ts: Date.now() });
          return;
        }
        if (msg.type === "pong") {
          return;
        }

        // C. BẮT ĐẦU LƯỢT NÓI (START / LISTEN: START)
        if (msg.type === "start" || (msg.type === "listen" && msg.state === "start")) {
          if (silenceTimer) clearTimeout(silenceTimer);
          audioChunks = [];
          hasVoiceActivity = false;
          voicePacketsCount = 0;
          silencePacketsCount = 0;
          sendJSON({ type: "state", state: "listening" });
          return;
        }

        // D. LỆNH CẮT NGANG (BARGE-IN / ABORT TỪ CẢM BIẾN CHẠM HOẶC MICRO)
        if (msg.type === "abort") {
          if (silenceTimer) clearTimeout(silenceTimer);
          if (abortController) {
            abortController.abort();
            abortController = null;
          }
          audioChunks = [];
          hasVoiceActivity = false;
          voicePacketsCount = 0;
          silencePacketsCount = 0;
          isProcessing = false;
          sendJSON({ type: "state", state: "idle", interrupted: true });
          if (isXiaozhiClient) {
            sendJSON({ type: "tts", state: "stop" });
          }
          return;
        }

        // E. KẾT THÚC GIỌNG NÓI (STOP / LISTEN: STOP / AUDIO_END)
        if (msg.type === "audio_end" || msg.type === "stop" || (msg.type === "listen" && msg.state === "stop")) {
          voicePacketsCount = 0;
          silencePacketsCount = 0;
          finishAndProcessAudio();
          return;
        }
      } catch (err) {
        sendJSON({ type: "error", message: "Invalid JSON control packet" });
      }
    }
  });

  server.addEventListener("close", () => {
    clearInterval(pingInterval);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (abortController) abortController.abort();
    audioChunks = [];
  });

  server.addEventListener("error", () => {
    clearInterval(pingInterval);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (abortController) abortController.abort();
  });
}

// ==============================================================================
// PHÁT ÂM THANH HOÀI MY NEURAL KÈM ĐỒNG BỘ THỜI LƯỢNG (DURATION PACING)
// KHẮC PHỤC TRIỆT ĐỂ LỖI ĐỌC LẮP BẮP / CẮT CÂU TRÊN ESP32
// ==============================================================================
async function speakWithPacing(text, sendJSON, sendBinary, signal) {
  if (!text || (signal && signal.aborted)) return;

  try {
    sendJSON({ type: "tts", state: "sentence_start", text: text });

    let mp3Buffer = null;

    // 1. Ưu tiên Edge TTS Hoài My Neural (24kHz MP3 48kbps)
    try {
      mp3Buffer = await fetchEdgeTTS(text, "vi-VN-HoaiMyNeural", "+0%", "audio-24khz-48kbitrate-mono-mp3", signal);
    } catch (e) {
      console.warn("[TTS] Hoai My error, fallback to Google TTS:", e.message);
    }

    // 2. Dự phòng Google Translate TTS nếu Edge TTS không kết nối được
    if (!mp3Buffer || mp3Buffer.byteLength === 0) {
      try {
        mp3Buffer = await fetchGoogleTTS(text, signal);
      } catch (e) {
        console.error("[TTS] Google TTS fallback failed:", e.message);
      }
    }

    if (!mp3Buffer || mp3Buffer.byteLength === 0 || (signal && signal.aborted)) {
      return;
    }

    // Gửi toàn bộ dữ liệu âm thanh MP3 về ESP32
    sendBinary(mp3Buffer);

    // Tính toán chính xác thời lượng âm thanh (MP3 48kbps mono ~ 6000 bytes/giây)
    // Thêm 300ms trừ hao thời gian giải mã I2S
    const durationMs = Math.max(1000, Math.round((mp3Buffer.byteLength / 6000) * 1000) + 300);

    // Đợi ESP32 phát xong toàn bộ trước khi cho phép server gửi lệnh tiếp theo
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, durationMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });

  } catch (err) {
    console.error("[speakWithPacing error]:", err.message);
  }
}

// ==============================================================================
// BỘ NHẬN DIỆN KHO NHẠC VIỆT (VIETNAMESE MUSIC CATALOG INTENT)
// ==============================================================================
function detectMusicIntent(rawText) {
  const lower = rawText.toLowerCase().replace(/[.,!?]/g, '').trim();

  const musicKeywords = [
    "hát", "hát đi", "hát một bài", "hát bài", "ca một bài",
    "mở bài", "bật bài", "phát bài", "nghe bài", "mở nhạc",
    "bật nhạc", "phát nhạc", "chơi bài", "chơi nhạc", "bài hát",
    "nghe nhạc", "play", "music", "song"
  ];

  const isMusic = musicKeywords.some(w => lower.includes(w));
  if (!isMusic) return { isMusic: false };

  // 1. Nhạc Lofi / Thư giãn / Chill / Học bài / Ngủ
  if (lower.includes("lofi") || lower.includes("chill") || lower.includes("thư giãn") || lower.includes("học bài") || lower.includes("ngủ")) {
    return { isMusic: true, type: "lofi", title: "Nhạc Lofi Chill Việt" };
  }

  // 2. Bolero / Trữ tình / Nhạc vàng / Quê hương
  if (lower.includes("bolero") || lower.includes("trữ tình") || lower.includes("nhạc vàng") || lower.includes("quê hương") || lower.includes("xưa")) {
    return { isMusic: true, type: "bolero", title: "Nhạc Trữ Tình Bolero" };
  }

  // 3. Remix / Vinahouse / Sôi động / Quẩy / EDM
  if (lower.includes("remix") || lower.includes("vinahouse") || lower.includes("vinahey") || lower.includes("sôi động") || lower.includes("quẩy") || lower.includes("dance") || lower.includes("edm") || lower.includes("bay")) {
    return { isMusic: true, type: "remix", title: "Nhạc Remix Vinahouse Sôi Động" };
  }

  // 4. Piano / Nhạc không lời / Cổ điển
  if (lower.includes("piano") || lower.includes("không lời") || lower.includes("cổ điển") || lower.includes("giao hưởng")) {
    return { isMusic: true, type: "piano", title: "Nhạc Piano Thư Giãn" };
  }

  // 5. Sài Gòn / Radio
  if (lower.includes("sài gòn") || lower.includes("radio") || lower.includes("đài")) {
    return { isMusic: true, type: "saigon", title: "Sài Gòn Radio 99.8" };
  }

  // 6. Nhạc Trẻ V-Pop Hot / Sơn Tùng / Đen Vâu / Vũ / Tăng Duy Tân / Mặc định
  return { isMusic: true, type: "vpop", title: "Nhạc Trẻ V-Pop Hot" };
}

// ==============================================================================
// BỘ LỌC ẢO GIÁC GROQ WHISPER
// ==============================================================================
function isWhisperHallucination(text) {
  const lower = text.toLowerCase().trim();
  const hallucinations = [
    "đăng ký kênh", "đăng kí kênh", "dang ky kenh", "subscribe", "sub kênh", "like và sub",
    "ủng hộ kênh", "hẹn gặp lại", "cảm ơn các bạn đã theo dõi", "cảm ơn đã theo dõi",
    "chúc các bạn", "video sau", "mời các bạn đón xem", "kênh của mình",
    "chia sẻ video", "hãy subscribe", "like và chia sẻ", "bấm chuông",
    "quý vị và các bạn", "chào mừng các bạn", "hẹn gặp lại quý vị", "đón xem video",
    "ghiền mì gõ", "ghien mi go", "tạm biệt và hẹn gặp lại", "hẹn gặp lại các bạn",
    "chúc bạn một ngày tốt lành", "hẹn gặp lại ở video sau"
  ];
  return hallucinations.some(h => lower.includes(h));
}

function isExitCommand(text) {
  const lower = text.toLowerCase().replace(/[.,!?]/g, '').trim();
  const exitKeywords = [
    "tạm biệt", "tam biet", "bye", "dừng lại", "dung lai",
    "kết thúc", "ket thuc", "thôi nha", "thôi nhé", "nghỉ thôi", "đủ rồi"
  ];
  return exitKeywords.some(w => lower.includes(w));
}

// ==============================================================================
// DỮ LIỆU THỜI GIAN THỰC (GMT+7 ASIA/HO_CHI_MINH)
// ==============================================================================
function getRealTimeContext() {
  const now = new Date();
  const timeFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  return {
    time: timeFormatter.format(now),
    date: dateFormatter.format(now)
  };
}

// ==============================================================================
// DỮ LIỆU THỜI TIẾT OPEN-METEO THỰC TẾ
// ==============================================================================
let cachedWeather = "";
let lastWeatherFetch = 0;

async function getDetailedWeatherAndContext(queryText = "") {
  const now = Date.now();
  const lower = (queryText || "").toLowerCase();

  // Bảng tọa độ các tỉnh thành phổ biến tại Việt Nam
  const CITIES = {
    "hà nội": { lat: 21.0285, lon: 105.8542, name: "Thủ đô Hà Nội" },
    "sài gòn": { lat: 10.8231, lon: 106.6297, name: "TP. Hồ Chí Minh" },
    "hồ chí minh": { lat: 10.8231, lon: 106.6297, name: "TP. Hồ Chí Minh" },
    "tphcm": { lat: 10.8231, lon: 106.6297, name: "TP. Hồ Chí Minh" },
    "đà nẵng": { lat: 16.0544, lon: 108.2022, name: "Đà Nẵng" },
    "cần thơ": { lat: 10.0452, lon: 105.7469, name: "Cần Thơ" },
    "hải phòng": { lat: 20.8449, lon: 106.6881, name: "Hải Phòng" },
    "huế": { lat: 16.4637, lon: 107.5909, name: "Huế" },
    "nha trang": { lat: 12.2388, lon: 109.1967, name: "Nha Trang" },
    "đà lạt": { lat: 11.9404, lon: 108.4583, name: "Đà Lạt" },
    "vũng tàu": { lat: 10.3460, lon: 107.0843, name: "Vũng Tàu" },
    "bình dương": { lat: 10.9805, lon: 106.6519, name: "Bình Dương" }
  };

  // Tìm tỉnh thành người dùng nhắc tới trong câu hỏi
  let targetCity = null;
  for (const [key, cityInfo] of Object.entries(CITIES)) {
    if (lower.includes(key)) {
      targetCity = cityInfo;
      break;
    }
  }

  // Nếu không chỉ định thành phố khác, dùng mặc định: Biên Hòa, Đồng Nai (có cache 10 phút)
  if (!targetCity) {
    if (cachedWeather && (now - lastWeatherFetch < 600000)) {
      return cachedWeather;
    }
    targetCity = { lat: 10.9574, lon: 106.8427, name: "Biên Hòa, Đồng Nai" };
  }

  try {
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${targetCity.lat}&longitude=${targetCity.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia%2FBangkok`;
    const res = await fetch(weatherUrl);

    if (res.ok) {
      const data = await res.json();
      const temp = Math.round(data.current?.temperature_2m ?? 28);
      const humidity = data.current?.relative_humidity_2m ?? 75;
      const apparentTemp = Math.round(data.current?.apparent_temperature ?? temp);
      const code = data.current?.weather_code ?? 0;
      const weatherDesc = wmoCodeToVietnamese(code);
      const tMax = Math.round(data.daily?.temperature_2m_max?.[0] ?? (temp + 3));
      const tMin = Math.round(data.daily?.temperature_2m_min?.[0] ?? (temp - 3));

      const weatherString = `Thời tiết tại ${targetCity.name}: Nhiệt độ hiện tại ${temp}°C (cảm giác như ${apparentTemp}°C), độ ẩm ${humidity}%, ${weatherDesc}. Dao động hôm nay từ ${tMin}°C đến ${tMax}°C.`;

      if (targetCity.name.includes("Biên Hòa")) {
        cachedWeather = weatherString;
        lastWeatherFetch = now;
      }
      return weatherString;
    }
  } catch (e) {
    console.warn("[Weather] Open-Meteo fetch error:", e.message);
  }

  return "Nhà bạn ở Biên Hòa, Đồng Nai. Thời tiết mát mẻ ổn định.";
}

function wmoCodeToVietnamese(code) {
  if (code === 0) return "trời quang đãng, nắng đẹp";
  if (code <= 3) return "trời có mây, nắng dịu mát";
  if (code === 45 || code === 48) return "có sương mù";
  if (code >= 51 && code <= 55) return "có mưa phùn nhẹ";
  if (code >= 61 && code <= 65) return "có mưa rào";
  if (code >= 80 && code <= 82) return "mưa rào từng cơn, có nơi mưa to";
  if (code >= 95) return "có dông bão sấm sét";
  return "thời tiết ổn định";
}

// ==============================================================================
// MICROSOFT EDGE DRM TOKEN GENERATOR (v2 Sec-MS-GEC)
// ==============================================================================
const _U32_MASK = 0xFFFFFFFF;
const _SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
];
const _SHA256_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2
];
const _SHA256_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564
];
const _SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
];
const _SHA256_ADJUSTMENT = 0xC9DC06A7;
const _SHA256_BLOCK_CONSTANTS = [
  ..._SHA256_ROUND_CONSTANTS.slice(0, 14),
  _SHA256_ADJUSTMENT,
  ..._SHA256_ROUND_CONSTANTS.slice(15)
];
const _SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const _SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

const _CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]
];
const _CS64_FACTOR = 0x82893933;
const _CS64_ADJUSTMENT0 = 0xF2F90B1A;
const _CS64_ADJUSTMENT1 = 0x0B1A0000;

function _rol16(v) {
  return (((v << 16) | (v >>> 16)) >>> 0);
}

function _words_le4_even(data) {
  const padLen = (-data.length % 4 + 4) % 4;
  const padded = new Uint8Array(data.length + padLen);
  padded.set(data);
  const words = [];
  const view = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 4) {
    words.push(view.getUint32(i, true));
  }
  if (words.length % 2 !== 0) words.push(0);
  return words;
}

function _sigma0(v) {
  return (((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0);
}

function _sigma1(v) {
  return (((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0);
}

function _expand_sha256_schedule(words, first_word = 16) {
  for (let i = first_word; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = ((x >>> 17) ^ (x << 15) ^ (x >>> 19) ^ (x << 13) ^ (x >>> 10));
    const s0 = ((y >>> 7) ^ (y << 25) ^ (y >>> 18) ^ (y << 14) ^ (y >>> 3));
    words.push((((s1 + words[i - 7]) >>> 0) + ((s0 + words[i - 16]) >>> 0)) >>> 0);
  }
}

function _sha256_rounds(state, words, first_round = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = (first_round === 14) ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((first_round + 7) / 8) * 8);

  for (let i = first_round; i < aligned; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (((h + s1) >>> 0) + ((ch + constants[i]) >>> 0) + words[i]) >>> 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    h = g; g = f; f = e;
    e = (d + t1) >>> 0;
    d = c; c = b; b = a;
    a = (t1 + t2) >>> 0;
  }

  for (let i = aligned; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (((h + s1) >>> 0) + ((ch + constants[i]) >>> 0) + words[i]) >>> 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    h = g; g = f; f = e;
    e = (d + t1) >>> 0;
    d = c; c = b; b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function _sha256_init(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const w14 = (data[0] << 16) | (data[1] << 8) | data[2];
  const w15 = view.getUint32(3, false);
  const words = new Array(14).fill(0).concat([w14, w15]);

  for (let i = 16; i < 30; i++) {
    let val = _SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      val = (val + ((i === 16) ? (_sigma1(words[i - 2]) ^ _SHA256_SIGMA1_ADJUSTMENT) : _sigma1(words[i - 2]))) >>> 0;
    }
    if (i - 7 >= 14) {
      val = (val + words[i - 7]) >>> 0;
    }
    if (i - 15 >= 14) {
      val = (val + ((i === 29) ? (_sigma0(words[i - 15]) ^ _SHA256_SIGMA0_ADJUSTMENT) : _sigma0(words[i - 15]))) >>> 0;
    }
    words.push(val >>> 0);
  }

  const w29 = (
    _sigma1(words[28]) + words[23] + _sigma0(words[15]) + words[14] + _SHA256_ADJUSTMENT - _SHA256_ROUND_CONSTANTS[14]
  ) >>> 0;
  words.push(w29);

  _expand_sha256_schedule(words, 31);
  const working = _sha256_rounds(_SHA256_STATE, words, 14);
  return _SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function _sha256_digest(data) {
  const length = 57 + data.length;
  const padZeros = ((55 - length) % 64 + 64) % 64;
  const totalLen = (data.length - 7) + 1 + padZeros + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  const bitLen = BigInt(length) * 8n;
  const pView = new DataView(padded.buffer);
  pView.setBigUint64(totalLen - 8, bitLen, false);

  let state = _sha256_init(data.subarray(0, 7));
  for (let offset = 0; offset < totalLen; offset += 64) {
    const words = [];
    for (let j = 0; j < 64; j += 4) {
      words.push(pView.getUint32(offset + j, false));
    }
    _expand_sha256_schedule(words);
    const working = _sha256_rounds(state, words);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }

  const outBuf = new Uint8Array(32);
  const outView = new DataView(outBuf.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, state[i], false);
  }
  return outBuf;
}

function _cs64_digest(data, digest) {
  const dView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  let key_a = (dView.getUint32(0, true) | 1) >>> 0;
  let key_b = (dView.getUint32(4, true) | 1) >>> 0;

  const factors = [
    Math.imul(key_a, _CS64_FACTOR) >>> 0,
    Math.imul(key_b, _CS64_FACTOR) >>> 0
  ];

  const terms = _CS64_COEFFICIENTS.map(([coef, _], idx) => Math.imul(coef, factors[idx % 2]) >>> 0);
  const offsets = _CS64_COEFFICIENTS.map(([_, off]) => off);

  const dataWithZero = new Uint8Array(data.length + 1);
  dataWithZero.set(data, 1);
  const words = _words_le4_even(dataWithZero);

  for (let idx = 0; idx < words.length; idx++) {
    const word = words[idx];
    let term = Math.imul(word, (idx % 2 === 0 ? key_a : key_b)) >>> 0;
    let offset = Math.imul(_rol16(word), (idx % 2 === 0 ? 0xEF0569FB : 0xC31713DB)) >>> 0;
    if (idx === 0) {
      term = (term + Math.imul(_CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + _CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swap_acc = 0, swap_last = 0, state = 0, acc = 0;
  for (let idx = 0; idx < terms.length; idx += 2) {
    const x = terms[idx], y = terms[idx + 1];
    let t = _rol16((offsets[idx] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swap_acc = (swap_acc + (Math.imul(_rol16(q), 0xC3EFEA97) >>> 0) + q) >>> 0;

    t = _rol16((offsets[idx + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swap_last = ((Math.imul(_rol16(q), 0x35BD1EC9) >>> 0) + q) >>> 0;
    swap_acc = (swap_acc + swap_last) >>> 0;

    state = (Math.imul(state, key_a) + x) >>> 0;
    state = Math.imul(_rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(_rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(_rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(_rol16(state), 0x257E1D83) >>> 0;
    acc = (acc + state) >>> 0;

    t = (Math.imul(state, key_b) + y) >>> 0;
    t = Math.imul(_rol16(t), 0xA27416F5) >>> 0;
    t = Math.imul(_rol16(t), 0xD38396FF) >>> 0;
    state = Math.imul(_rol16(Math.imul(_rol16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [(swap_last ^ state) >>> 0, (swap_acc ^ acc) >>> 0];
}

function generateSecMsGecV2(unixTimestamp = null) {
  const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const WIN_EPOCH = 11644473600;
  let ticks = unixTimestamp !== null ? Number(unixTimestamp) : (Date.now() / 1000);
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;

  const strToHash = `${Math.floor(ticks)}${TRUSTED_TOKEN}`;
  const data = new TextEncoder().encode(strToHash);
  const digest = _sha256_digest(data);
  const [cs0, cs1] = _cs64_digest(data, digest);

  const csBuf = new Uint8Array(8);
  const csView = new DataView(csBuf.buffer);
  csView.setUint32(0, cs0, true);
  csView.setUint32(4, cs1, true);

  const csHex = Array.from(csBuf).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const shaHex = Array.from(digest).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

  return `${csHex}-${shaHex}`;
}

// ==============================================================================
// MICROSOFT EDGE NEURAL TTS (HOÀI MY - vi-VN-HoaiMyNeural - 24kHz MP3)
// ==============================================================================
async function fetchEdgeTTS(text, voice = "vi-VN-HoaiMyNeural", rate = "+0%", format = "audio-24khz-48kbitrate-mono-mp3", signal = null) {
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const secMsGec = generateSecMsGecV2();
  const secMsGecVersion = "2-143.0.3650.75";
  const muid = crypto.randomUUID().replace(/-/g, "").toUpperCase();

  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${secMsGecVersion}&ConnectionId=${connectionId}`;

  const resp = await fetch(url, {
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      "Cookie": `muid=${muid};`
    }
  });

  const ws = resp.webSocket;
  if (!ws) throw new Error("Edge TTS WebSocket upgrade failed: " + resp.status);
  ws.accept();

  return new Promise((resolve, reject) => {
    const chunks = [];
    let timeout = setTimeout(() => {
      try { ws.close(); } catch(e) {}
      reject(new Error("Edge TTS timeout (6s)"));
    }, 6000);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        try { ws.close(); } catch(e) {}
        reject(new Error("Aborted"));
      });
    }

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timeout);
          try { ws.close(); } catch(e) {}
          let totalLen = 0;
          for (const c of chunks) totalLen += c.byteLength;
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            merged.set(new Uint8Array(c), offset);
            offset += c.byteLength;
          }
          resolve(merged.buffer);
        }
      } else if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const headerLen = view.getUint16(0);
        if (event.data.byteLength > 2 + headerLen) {
          chunks.push(event.data.slice(2 + headerLen));
        }
      }
    });

    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error("Edge TTS WS error"));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      if (chunks.length > 0) {
        let totalLen = 0;
        for (const c of chunks) totalLen += c.byteLength;
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(new Uint8Array(c), offset);
          offset += c.byteLength;
        }
        resolve(merged.buffer);
      }
    });

    // Send speech.config
    ws.send(
      "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "false",
                wordBoundaryEnabled: "false"
              },
              outputFormat: format
            }
          }
        }
      }) + "\r\n"
    );

    // Send SSML
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const cleanText = text.replace(/[*_#~<>&]/g, ' ').trim();
    const ssml =
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `Path:ssml\r\n\r\n` +
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'>` +
      `<voice name='${voice}'>` +
      `<prosody rate='${rate}' pitch='+0Hz'>${cleanText}</prosody>` +
      `</voice></speak>`;

    ws.send(ssml);
  });
}

// ==============================================================================
// DỰ PHÒNG: GOOGLE TRANSLATE TTS
// ==============================================================================
async function fetchGoogleTTS(text, signal = null) {
  const encodedText = encodeURIComponent(text.trim());
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodedText}`;
  const res = await fetch(ttsUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    signal: signal
  });
  if (!res.ok) throw new Error(`Google TTS failed: ${res.status}`);
  return await res.arrayBuffer();
}

// ==============================================================================
// ĐÓNG GÓI OPUS VÀ PCM SANG FILE CHUẨN CHO GROQ WHISPER STT
// ==============================================================================
const OGG_CRC_TABLE = new Uint32Array(256);
(function initCRC() {
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    }
    OGG_CRC_TABLE[i] = r >>> 0;
  }
})();

function oggCrc(buf) {
  const u8 = new Uint8Array(buf);
  let crc = 0;
  for (let i = 0; i < u8.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ u8[i]) & 0xff]) >>> 0;
  }
  return crc;
}

function opusPacketsToOgg(packets, sampleRate = 16000) {
  const serial = 0x12345678;
  const pages = [];

  function createPage(headerType, granule, seq, payloadBuf) {
    const payload = new Uint8Array(payloadBuf);
    const numSegments = Math.ceil(payload.length / 255) || 1;
    const headerLen = 27 + numSegments;
    const pageLen = headerLen + payload.length;
    const page = new ArrayBuffer(pageLen);
    const view = new DataView(page);
    const u8 = new Uint8Array(page);

    u8[0] = 0x4f; u8[1] = 0x67; u8[2] = 0x67; u8[3] = 0x53; // "OggS"
    u8[4] = 0; // version
    u8[5] = headerType;
    view.setBigInt64(6, BigInt(granule), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, seq, true);
    view.setUint32(22, 0, true); // CRC placeholder
    u8[26] = numSegments;

    let rem = payload.length;
    for (let i = 0; i < numSegments; i++) {
      const seg = Math.min(rem, 255);
      u8[27 + i] = seg;
      rem -= seg;
    }

    u8.set(payload, headerLen);
    const crc = oggCrc(page);
    view.setUint32(22, crc, true);
    return page;
  }

  // Page 0: OpusHead
  const headBuf = new ArrayBuffer(19);
  const headView = new DataView(headBuf);
  const headU8 = new Uint8Array(headBuf);
  const magic = "OpusHead";
  for (let i = 0; i < 8; i++) headU8[i] = magic.charCodeAt(i);
  headU8[8] = 1;
  headU8[9] = 1;
  headView.setUint16(10, 0, true);
  headView.setUint32(12, sampleRate, true);
  headView.setUint16(16, 0, true);
  headU8[18] = 0;
  pages.push(createPage(0x02, 0, 0, headBuf));

  // Page 1: OpusTags
  const tagBuf = new ArrayBuffer(24);
  const tagView = new DataView(tagBuf);
  const tagU8 = new Uint8Array(tagBuf);
  const tagMagic = "OpusTags";
  for (let i = 0; i < 8; i++) tagU8[i] = tagMagic.charCodeAt(i);
  tagView.setUint32(8, 8, true);
  const vendor = "xiaozhi\0";
  for (let i = 0; i < 8; i++) tagU8[12 + i] = vendor.charCodeAt(i);
  tagView.setUint32(20, 0, true);
  pages.push(createPage(0x00, 0, 1, tagBuf));

  // Audio pages
  let granule = 0;
  const samplesPerFrame = sampleRate === 16000 ? 960 : 1440;
  let pageSeq = 2;

  for (let i = 0; i < packets.length; i++) {
    granule += samplesPerFrame;
    const isLast = (i === packets.length - 1);
    const headerType = isLast ? 0x04 : 0x00;
    pages.push(createPage(headerType, granule, pageSeq++, packets[i]));
  }

  let totalSize = 0;
  for (const p of pages) totalSize += p.byteLength;
  const finalOgg = new Uint8Array(totalSize);
  let off = 0;
  for (const p of pages) {
    finalOgg.set(p, off);
    off += p.byteLength;
  }
  return finalOgg.buffer;
}

function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.byteLength;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const wavBuffer = new Uint8Array(44 + dataSize);
  wavBuffer.set(new Uint8Array(header), 0);
  wavBuffer.set(new Uint8Array(pcmBuffer), 44);
  return wavBuffer.buffer;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
