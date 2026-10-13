// ==============================================================================
// CLOUDFLARE WORKER: ESP32-S3 FULL-DUPLEX AI (XIAOZHI STYLE) & HTTP REST BACKEND
// Hỗ trợ cả 2 chế độ:
// 1. WebSocket /ws: Full-Duplex Real-Time Streaming + Voice Barge-in (Cắt ngang)
// 2. HTTP /chat & /tts: Chế độ truyền thống (Tương thích ngược 100%)
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
      handleWebSocketSession(server, env, request);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // --------------------------------------------------------------------------
    // CỔNG 2: HTTP POST /chat - REST STT + LLM (TƯƠNG THÍCH BẢN CŨ)
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
            const errorText = await sttResponse.text();
            let shortError = errorText;
            try {
               const errJson = JSON.parse(errorText);
               if (errJson.error && errJson.error.message) {
                   shortError = errJson.error.message;
               }
            } catch(e) {}
            throw new Error(`STT: ${shortError}`);
        }
        const sttData = await sttResponse.json();
        const userText = (sttData.text || "").trim();

        if (!userText) return new Response(JSON.stringify({ error: "No speech" }), { status: 400 });

        // Lọc triệt để ảo giác (hallucination) thường gặp của Whisper khi âm thanh im lặng/nhiễu
        const lowerRaw = userText.toLowerCase();
        const whisperHallucinations = [
          "đăng ký kênh", "đăng kí kênh", "dang ky kenh", "subscribe", "sub kênh", "like và sub",
          "ủng hộ kênh", "hẹn gặp lại", "cảm ơn các bạn đã theo dõi",
          "chúc các bạn", "video sau", "mời các bạn đón xem", "kênh của mình",
          "chia sẻ video", "hãy subscribe", "like và chia sẻ", "bấm chuông",
          "quý vị và các bạn", "chào mừng các bạn", "hẹn gặp lại quý vị", "đón xem video"
        ];
        const isHallucination = whisperHallucinations.some(h => lowerRaw.includes(h));
        if (isHallucination) {
          return new Response(JSON.stringify({ error: "Hallucination filtered", no_speech: true }), { status: 400 });
        }

        // Tự động lấy thời tiết và thông tin phòng
        let weatherContext = await getWeatherAndContext(request);

        // Kiểm tra yêu cầu mở nhạc / phát bài hát / hát
        const musicKeywords = [
          "hát", "hát đi", "hát một bài", "hát bài", "ca một bài",
          "mở bài", "bật bài", "phát bài", "nghe bài", "mở nhạc",
          "bật nhạc", "phát nhạc", "chơi bài", "chơi nhạc", "bài hát",
          "nghe nhạc", "play", "music", "song"
        ];
        const lowerUser = userText.toLowerCase();
        const isMusic = musicKeywords.some(w => lowerUser.includes(w));
        let musicUrl = "";

        if (isMusic) {
          let streamType = "vpop";
          if (lowerUser.includes("lofi") || lowerUser.includes("chill") || lowerUser.includes("thư giãn") || lowerUser.includes("ngủ")) {
            streamType = "lofi";
          } else if (lowerUser.includes("piano") || lowerUser.includes("không lời")) {
            streamType = "piano";
          } else if (lowerUser.includes("dance") || lowerUser.includes("edm") || lowerUser.includes("sôi động") || lowerUser.includes("tiếng anh")) {
            streamType = "dance";
          }
          musicUrl = `${url.origin}/music?type=${streamType}`;
        }

        const lastUserEnc = request.headers.get("X-Last-User");
        const lastAiEnc = request.headers.get("X-Last-AI");
        const msgList = [
          { role: "system", content: `Bạn là trợ lý AI thông minh, hiểu biết sâu rộng, thân thiện và gần gũi.
QUY TẮC XƯNG HÔ BẮT BUỘC: Luôn luôn xưng là "tôi" và gọi người dùng là "bạn" (tuyệt đối không xưng em, không gọi anh/chị, không dùng dạ/thưa, không dùng câu hỏi rập khuôn như bạn cần gì/anh cần giúp gì).
PHONG CÁCH TRẢ LỜI: Hãy trả lời tự nhiên, thân thiện và súc tích (khoảng 2 đến 3 câu, dưới 60 từ) phù hợp với đàm thoại giọng nói qua loa thông minh. Đầy đủ ý, nói thẳng vào trọng tâm câu hỏi của người dùng. Tuyệt đối không dùng ký tự markdown như *, #, ~, gạch đầu dòng.
XỬ LÝ TẠP ÂM: Nếu câu người dùng không rõ ràng hoặc có từ ngữ về đăng ký kênh/YouTube do nhận diện nhầm, chỉ cần vui vẻ nói: "Tôi đang lắng nghe bạn đây, bạn hãy nói lại nhé." Tuyệt đối không nhắc lại chuyện đăng ký kênh. ${weatherContext}` }
        ];
        
        if (lastUserEnc && lastAiEnc) {
            try {
                const lastUser = decodeURIComponent(lastUserEnc.replace(/\+/g, ' '));
                const lastAi = decodeURIComponent(lastAiEnc.replace(/\+/g, ' '));
                if (lastUser.length > 0 && lastAi.length > 0) {
                    msgList.push({ role: "user", content: lastUser });
                    msgList.push({ role: "assistant", content: lastAi });
                }
            } catch(e) {}
        }
        
        msgList.push({ role: "user", content: userText });

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

        if (!llmResponse.ok) throw new Error(`LLM Failed`);

        const llmData = await llmResponse.json();
        let aiText = llmData.choices[0].message.content.trim();
        if (!aiText) aiText = isMusic ? "Tôi đang mở nhạc cho bạn đây, chúc bạn nghe vui vẻ!" : "Tôi không có câu trả lời.";
        aiText = aiText.replace(/[*_#~]/g, '');

        const exitKeywords = [
          "từ từ", "tu tu", "chờ chút", "cho chut", "đợi chút", "doi chut", "khoan",
          "dừng", "dừng lại", "dung lai", "tạm biệt", "tam biet", "cảm ơn", "cam on",
          "đủ rồi", "du roi", "bye", "nghỉ thôi", "kết thúc", "ket thuc", "thôi nha", "thôi nhé"
        ];
        const isExit = exitKeywords.some(w => lowerUser.includes(w));

        // Nhận diện cảm xúc cho 2 mắt robot
        let emotion = "happy";
        const lowerAi = aiText.toLowerCase();
        if (lowerAi.includes("buồn") || lowerAi.includes("tiếc") || lowerAi.includes("xin lỗi") || lowerAi.includes("khó")) {
            emotion = "sad";
        } else if (lowerAi.includes("ồ") || lowerAi.includes("wow") || lowerAi.includes("thật sao") || lowerAi.includes("bất ngờ")) {
            emotion = "surprised";
        } else if (lowerAi.includes("suy nghĩ") || lowerAi.includes("để xem") || lowerAi.includes("chờ chút")) {
            emotion = "thinking";
        } else if (lowerAi.includes("vui") || lowerAi.includes("tuyệt") || lowerAi.includes("haha") || lowerAi.includes("thích") || lowerAi.includes("chúc") || lowerAi.includes("sẵn sàng") || lowerAi.includes("chào") || isExit || isMusic) {
            emotion = "happy";
        } else {
            emotion = "speaking";
        }

        return new Response(JSON.stringify({
          user: userText,
          text: aiText,
          user_text: userText,
          ai_text: aiText,
          emotion: emotion,
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
    // CỔNG 3: HTTP GET /tts - CHUYỂN VĂN BẢN THÀNH GIỌNG NÓI MP3 (TƯƠNG THÍCH BẢN CŨ)
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/tts") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing text parameter", { status: 400 });

      const FPT_API_KEY = env.FPT_API_KEY;
      const ZALO_API_KEY = env.ZALO_API_KEY;

      if (ZALO_API_KEY) {
        try {
          const params = new URLSearchParams();
          params.append('input', text);
          params.append('speaker_id', '1');
          params.append('speed', '1.0');
          params.append('encode_type', '1');

          const zaloRes = await fetch("https://api.zalo.ai/v1/tts/synthesize", {
            method: "POST",
            headers: {
              "apikey": ZALO_API_KEY,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
          });

          if (zaloRes.ok) {
            const zaloData = await zaloRes.json();
            if (zaloData.error_code === 0 && zaloData.data && zaloData.data.url) {
              const asyncUrl = zaloData.data.url;
              for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 400));
                const audioRes = await fetch(asyncUrl);
                if (audioRes.ok) {
                  const mp3Buffer = await audioRes.arrayBuffer();
                  if (mp3Buffer.byteLength > 100) {
                    return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error("Zalo TTS failed, fallback to Google TTS:", e);
        }
      }

      if (FPT_API_KEY) {
        try {
          const fptRes = await fetch("https://api.fpt.ai/hmi/tts/v5", {
            method: "POST",
            headers: {
              "api-key": FPT_API_KEY,
              "voice": "banmai", 
              "speed": "0" 
            },
            body: text
          });

          if (fptRes.ok) {
            const fptData = await fptRes.json();
            const asyncUrl = fptData.async;

            for (let i = 0; i < 30; i++) {
              const audioRes = await fetch(asyncUrl);
              if (audioRes.ok) {
                const contentType = audioRes.headers.get("content-type") || "";
                if (contentType.includes("audio") || contentType.includes("mpeg") || contentType.includes("octet-stream")) {
                  const mp3Buffer = await audioRes.arrayBuffer();
                  return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
                }
              }
              await new Promise(r => setTimeout(r, 500));
            }
          }
        } catch (e) {
          console.error("FPT TTS failed, fallback to Google TTS:", e);
        }
      }

      // DỰ PHÒNG HOÀN HẢO: Nếu Zalo hoặc FPT lỗi/hết lượt/quá dài, tự động dùng Google TTS siêu tốc!
      try {
        const mp3Buffer = await fetchGoogleTTS(text);
        return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
      } catch (e) {
        return new Response("TTS Failed: " + e.message, { status: 500 });
      }
    }

    // --------------------------------------------------------------------------
    // CỔNG 4: HTTP GET /music - PROXY STREAM NHẠC MP3 TRỰC TIẾP CHO ESP32
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/music") {
      const type = url.searchParams.get("type") || "vpop";
      let target = "https://stream.zeno.fm/0r0xa792kwzuv";
      if (type === "lofi") target = "https://stream.zeno.fm/f3wvbbqmdg8uv";
      else if (type === "piano") target = "https://streams.ilovemusic.de/iloveradio26.mp3";
      else if (type === "dance") target = "https://streams.ilovemusic.de/iloveradio17.mp3";

      const streamRes = await fetch(target, {
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
    }

    // --------------------------------------------------------------------------
    // CỔNG 5: TEST & STATUS
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/test_chat") {
      return new Response("ESP32 AI Backend & WebSocket /ws is ready!", { status: 200 });
    }

    return new Response("ESP32 AI Backend is active! WebSocket endpoint: /ws", { status: 200 });
  }
};

// ==============================================================================
// XỬ LÝ PHIÊN WEBSOCKET FULL-DUPLEX CHO ESP32-S3
// ==============================================================================
function handleWebSocketSession(server, env, initialRequest) {
  let audioChunks = [];
  let isProcessing = false;
  let abortController = null;
  let conversationHistory = [];
  let roomContext = "";

  // Helper gửi JSON an toàn
  const sendJSON = (obj) => {
    try {
      server.send(JSON.stringify(obj));
    } catch (e) {}
  };

  // Helper gửi âm thanh Binary MP3 an toàn
  const sendBinary = (arrayBuffer) => {
    try {
      server.send(arrayBuffer);
    } catch (e) {}
  };

  server.addEventListener("message", async (event) => {
    // 1. NHẬN DỮ LIỆU NHỊ PHÂN (PCM AUDIO CHUNK TỪ MICRO INMP441)
    if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength > 0) {
        audioChunks.push(new Uint8Array(event.data));
      }
      return;
    }

    // 2. NHẬN LỆNH ĐIỀU KHIỂN DẠNG TEXT / JSON
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);

        // Keep-alive Ping/Pong
        if (msg.type === "ping") {
          sendJSON({ type: "pong", ts: Date.now() });
          return;
        }

        // Bắt đầu lượt nói mới
        if (msg.type === "start") {
          audioChunks = [];
          if (msg.temp || msg.hum) {
            roomContext = `Nhiệt độ phòng hiện tại: ${msg.temp || "--"}°C, độ ẩm: ${msg.hum || "--"}%. `;
          }
          sendJSON({ type: "state", state: "listening" });
          return;
        }

        // Lệnh cắt ngang (Voice Barge-in từ người dùng)
        if (msg.type === "abort") {
          if (abortController) {
            abortController.abort();
            abortController = null;
          }
          audioChunks = [];
          isProcessing = false;
          sendJSON({ type: "state", state: "idle", interrupted: true });
          return;
        }

        // Kết thúc giọng nói -> Bắt đầu xử lý Full-Duplex pipeline
        if (msg.type === "audio_end" || msg.type === "stop") {
          if (isProcessing) return;
          if (audioChunks.length === 0) {
            sendJSON({ type: "state", state: "idle" });
            return;
          }

          isProcessing = true;
          abortController = new AbortController();
          const signal = abortController.signal;

          sendJSON({ type: "state", state: "thinking" });

          try {
            // Gộp tất cả chunks PCM thành một Buffer lớn
            let totalLength = 0;
            for (const chunk of audioChunks) totalLength += chunk.byteLength;
            const fullPcm = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of audioChunks) {
              fullPcm.set(chunk, offset);
              offset += chunk.byteLength;
            }
            audioChunks = []; // Dọn dẹp RAM

            // Nếu âm thanh quá ngắn (< 0.3s ~ 9600 bytes tại 16kHz 16bit)
            if (fullPcm.byteLength < 9600) {
              sendJSON({ type: "state", state: "idle" });
              isProcessing = false;
              return;
            }

            // Chuyển PCM sang WAV Header chuẩn
            const wavBuffer = pcmToWav(fullPcm.buffer, 16000, 1, 16);

            // BƯỚC 1: GROQ WHISPER STT
            const formData = new FormData();
            formData.append("file", new File([wavBuffer], "audio.wav", { type: "audio/wav" }));
            formData.append("model", "whisper-large-v3-turbo");
            formData.append("language", "vi");
            formData.append("response_format", "json");

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
              sendJSON({ type: "state", state: "idle" });
              isProcessing = false;
              return;
            }

            // Bắn ngay kết quả STT về ESP32 để hiện lên màn hình TFT!
            sendJSON({ type: "stt", text: userText });

            const lowerUser = userText.toLowerCase().replace(/[.,!?]/g, '').trim();

            // Lọc triệt để ảo giác (hallucination) của Whisper khi âm thanh bị nhiễu / tiếng quạt
            const whisperHallucinations = [
              "đăng ký kênh", "đăng kí kênh", "dang ky kenh", "subscribe", "sub kênh", "like và sub",
              "ủng hộ kênh", "hẹn gặp lại", "cảm ơn các bạn đã theo dõi",
              "chúc các bạn", "video sau", "mời các bạn đón xem", "kênh của mình",
              "chia sẻ video", "hãy subscribe", "like và chia sẻ", "bấm chuông",
              "quý vị và các bạn", "chào mừng các bạn", "hẹn gặp lại quý vị", "đón xem video",
              "ghiền mì gõ", "ghien mi go"
            ];
            const isHallucination = whisperHallucinations.some(h => lowerUser.includes(h));
            if (isHallucination) {
              console.log("[Worker WS] Loc bo ao giac Whisper:", userText);
              sendJSON({ type: "state", state: "listening" });
              isProcessing = false;
              return;
            }

            // 1. Kiểm tra lệnh ngắt / dừng tạm thời (Barge-in / Pause)
            const pauseKeywords = ["từ từ", "tu tu", "chờ chút", "cho chut", "đợi chút", "doi chut", "khoan", "chờ đã", "đợi đã", "im", "im lặng"];
            const isPause = pauseKeywords.some(w => lowerUser === w || lowerUser.startsWith(w));

            // 2. Kiểm tra lệnh thoát hoàn toàn
            const exitKeywords = ["tạm biệt", "tam biet", "bye", "dừng lại", "dung lai", "kết thúc", "ket thuc", "thôi nha", "thôi nhé", "nghỉ thôi", "đủ rồi"];
            const isExit = exitKeywords.some(w => lowerUser.includes(w));

            // 3. Kiểm tra từ khóa gọi đánh thức (Wake word)
            const wakeKeywords = ["hey ai", "hello fen", "hello ai", "ai ơi", "bạn ơi", "fen ơi", "alo", "ê ai", "hey", "hello"];
            const isOnlyWake = wakeKeywords.some(w => lowerUser === w);

            // Xử lý phản hồi nhanh (Không cần tốn thời gian gọi LLM)
            if (isPause) {
              sendJSON({ type: "state", state: "speaking" });
              await synthesizeAndStreamAudio("Vâng, tôi đang đợi bạn đây.", sendJSON, sendBinary, signal);
              sendJSON({ type: "done", user_text: userText, ai_text: "Vâng, tôi đang đợi bạn đây.", exit: false });
              return;
            }

            if (isExit) {
              sendJSON({ type: "state", state: "speaking" });
              await synthesizeAndStreamAudio("Tạm biệt bạn nhé, chúc bạn một ngày tốt lành!", sendJSON, sendBinary, signal);
              sendJSON({ type: "done", user_text: userText, ai_text: "Tạm biệt bạn nhé!", exit: true });
              return;
            }

            if (isOnlyWake) {
              sendJSON({ type: "state", state: "speaking" });
              await synthesizeAndStreamAudio("Tôi nghe đây, bạn cần tôi giúp gì nào?", sendJSON, sendBinary, signal);
              sendJSON({ type: "done", user_text: userText, ai_text: "Tôi nghe đây, bạn cần tôi giúp gì nào?", exit: false });
              return;
            }

            // BƯỚC 2: STREAMING GROQ LLM (Qwen)
            let weatherContext = await getWeatherAndContext(initialRequest);
            const systemPrompt = `Bạn là trợ lý ảo AI thông minh, vui vẻ và tự nhiên.
QUY TẮC BẮT BUỘC: Luôn xưng "tôi" và gọi người dùng là "bạn". Tuyệt đối không dùng anh/chị hay dạ/thưa.
Hãy trả lời ngắn gọn, cô đọng từ 1 đến 3 câu (dưới 35 từ) để tương tác mượt mà trong thời gian thực. Không dùng ký tự markdown như *, #. ${roomContext}${weatherContext}`;

            const messages = [
              { role: "system", content: systemPrompt },
              ...conversationHistory.slice(-4), // Giữ 2 lượt hội thoại gần nhất
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
                max_tokens: 120,
                stream: true // KÍCH HOẠT STREAMING ĐỘNG
              }),
              signal
            });

            if (!llmRes.ok || !llmRes.body) throw new Error("LLM Stream Failed");

            sendJSON({ type: "state", state: "speaking" });

            // BƯỚC 3: SENTENCE STREAMING & REALTIME TTS PIPELINE
            const reader = llmRes.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let accumulatedAiText = "";
            let sentenceBuffer = "";
            let sseBuffer = "";

            while (true) {
              if (signal.aborted) break;
              const { done, value } = await reader.read();
              if (done) break;

              sseBuffer += decoder.decode(value, { stream: true });
              const lines = sseBuffer.split("\n");
              sseBuffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                if (trimmed === "data: [DONE]") break;

                try {
                  const dataJson = JSON.parse(trimmed.slice(6));
                  const delta = dataJson.choices?.[0]?.delta?.content || "";
                  if (delta) {
                    accumulatedAiText += delta;
                    sentenceBuffer += delta;

                    // Gửi token chữ về cho ESP32 hiển thị cuộn chữ
                    sendJSON({ type: "llm_delta", delta: delta });

                    // Tách cụm câu dựa vào dấu ngắt câu hoặc độ dài
                    if (hasSentenceBoundary(sentenceBuffer)) {
                      const sentenceToSpeak = cleanSentence(sentenceBuffer);
                      sentenceBuffer = "";

                      if (sentenceToSpeak.length > 1 && !signal.aborted) {
                        await synthesizeAndStreamAudio(sentenceToSpeak, sendJSON, sendBinary, signal);
                      }
                    }
                  }
                } catch (e) {}
              }
            }

            // Xử lý nốt phần còn sót lại trong buffer
            if (sentenceBuffer.trim().length > 0 && !signal.aborted) {
              const remainingSentence = cleanSentence(sentenceBuffer);
              if (remainingSentence.length > 1) {
                await synthesizeAndStreamAudio(remainingSentence, sendJSON, sendBinary, signal);
              }
            }

            // Cập nhật lịch sử
            if (!signal.aborted && accumulatedAiText.trim()) {
              conversationHistory.push({ role: "user", content: userText });
              conversationHistory.push({ role: "assistant", content: accumulatedAiText.trim() });
              if (conversationHistory.length > 6) conversationHistory.splice(0, 2);
            }

            sendJSON({
              type: "done",
              user_text: userText,
              ai_text: accumulatedAiText.trim(),
              exit: isExit
            });

          } catch (err) {
            if (!signal.aborted) {
              sendJSON({ type: "error", message: err.message });
            }
          } finally {
            isProcessing = false;
            abortController = null;
            sendJSON({ type: "state", state: "idle" });
          }
        }
      } catch (err) {
        sendJSON({ type: "error", message: "Invalid JSON control packet" });
      }
    }
  });

  server.addEventListener("close", () => {
    if (abortController) abortController.abort();
    audioChunks = [];
  });

  server.addEventListener("error", () => {
    if (abortController) abortController.abort();
  });
}

// ==============================================================================
// HÀM TIỆN ÍCH CHO FULL-DUPLEX & TTS STREAMING
// ==============================================================================

// Nhận biết kết thúc một cụm câu / mệnh đề để bắn TTS ngay
function hasSentenceBoundary(str) {
  if (str.length > 50) return true; // Quá 50 ký tự thì ngắt câu để nói ngay
  return /[.,!?;:\n]/.test(str);
}

function cleanSentence(str) {
  return str.replace(/[*_#~]/g, '').trim();
}

// Tổng hợp TTS siêu tốc bằng Google Translate (Trả MP3 trong <150ms)
async function synthesizeAndStreamAudio(text, sendJSON, sendBinary, signal) {
  try {
    sendJSON({ type: "audio_start", text: text });
    const mp3Buffer = await fetchGoogleTTS(text, signal);
    if (signal.aborted) return;
    
    // Gửi trực tiếp nhị phân MP3 tới ESP32 để giải mã I2S
    sendBinary(mp3Buffer);
    sendJSON({ type: "audio_end" });
  } catch (e) {
    // Nếu lỗi TTS thì bỏ qua câu này để tiếp tục mạch nói
  }
}

async function fetchGoogleTTS(text, signal = null) {
  const clean = text.trim();
  if (clean.length <= 160) {
    return await fetchSingleGoogleTTS(clean, signal);
  }

  // Chia nhỏ câu theo dấu chấm, phẩy hoặc khoảng trắng (<150 ký tự) để Google TTS không bao giờ bị lỗi 400
  const chunks = [];
  let remaining = clean;
  while (remaining.length > 0) {
    if (remaining.length <= 150) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf(".", 150);
    if (splitIdx === -1) splitIdx = remaining.lastIndexOf(",", 150);
    if (splitIdx === -1) splitIdx = remaining.lastIndexOf(" ", 150);
    if (splitIdx === -1) splitIdx = 150;
    else splitIdx += 1;

    const part = remaining.slice(0, splitIdx).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitIdx).trim();
  }

  // Tải song song tất cả các đoạn MP3
  const buffers = await Promise.all(chunks.map(c => fetchSingleGoogleTTS(c, signal)));

  // Nối các khối MP3 nhị phân thành 1 file MP3 hoàn chỉnh duy nhất
  let totalLength = 0;
  for (const b of buffers) totalLength += b.byteLength;
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    merged.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return merged.buffer;
}

async function fetchSingleGoogleTTS(text, signal = null) {
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

// Chuyển PCM thô thành WAV Buffer hợp lệ cho Groq Whisper
function pcmToWav(pcmBuffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.byteLength;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF Chunk
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");

  // fmt Subchunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data Subchunk
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

// Lấy thông tin thời tiết & thời gian tự động
async function getWeatherAndContext(request) {
  try {
    const city = request.cf?.city && request.cf.city !== "Việt Nam" ? request.cf.city : "Biên Hòa, Đồng Nai";
    const lat = request.cf?.latitude || 10.9454;
    const lon = request.cf?.longitude || 106.8243;
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m`);
    let outsideInfo = "";
    if (weatherRes.ok) {
      const wData = await weatherRes.json();
      outsideInfo = `Thời tiết ngoài trời ${city}: ${wData.current.temperature_2m}°C, độ ẩm ${wData.current.relative_humidity_2m}%. `;
    }
    const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "full", timeStyle: "short" });
    return `(Thời gian hiện tại: ${now}. ${outsideInfo})`;
  } catch (e) {
    return "";
  }
}
