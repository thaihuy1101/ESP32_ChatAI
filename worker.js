// ==============================================================================
// CLOUDFLARE WORKER: ESP32-S3 FULL-DUPLEX AI (XIAOZHI & REST SUPPORT)
// TTS CHÍNH: Microsoft Edge Neural TTS - Giọng HOÀI MY (vi-VN-HoaiMyNeural)
// Hỗ trợ:
// 1. WebSocket /ws: Giao thức Xiaozhi (hello, listen, stt, tts) + Voice Barge-in
// 2. HTTP /chat, /tts, /music, /test_chat: Tương thích ngược toàn diện
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

        // Lọc ảo giác Whisper
        const lowerRaw = userText.toLowerCase();
        const whisperHallucinations = [
          "đăng ký kênh", "đăng kí kênh", "dang ky kenh", "subscribe", "sub kênh", "like và sub",
          "ủng hộ kênh", "hẹn gặp lại", "cảm ơn các bạn đã theo dõi",
          "chúc các bạn", "video sau", "mời các bạn đón xem", "kênh của mình",
          "chia sẻ video", "hãy subscribe", "like và chia sẻ", "bấm chuông",
          "quý vị và các bạn", "chào mừng các bạn", "hẹn gặp lại quý vị", "đón xem video",
          "ghiền mì gõ", "ghien mi go"
        ];
        if (whisperHallucinations.some(h => lowerRaw.includes(h))) {
          return new Response(JSON.stringify({ error: "Hallucination filtered", no_speech: true }), { status: 400 });
        }

        let weatherContext = await getWeatherAndContext(request);

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

        const msgList = [
          { role: "system", content: `Bạn là trợ lý AI thông minh, hiểu biết sâu rộng, thân thiện và gần gũi.
QUY TẮC XƯNG HÔ BẮT BUỘC: Bạn với tui. Luôn xưng là "tôi" và gọi người dùng là "bạn" (tuyệt đối không xưng em, không gọi anh/chị, không dùng dạ/thưa, không dùng câu hỏi rập khuôn như bạn cần gì/anh cần giúp gì).
VỊ TRÍ MẶC ĐỊNH: Nhà của bạn ở Biên Hòa, Đồng Nai. Khi hỏi thời tiết hoặc hỏi địa điểm mà không nói rõ ở đâu, luôn mặc định là thời tiết tại Biên Hòa.
PHONG CÁCH TRẢ LỜI: Hãy trả lời tự nhiên, thân thiện và súc tích (khoảng 2 đến 3 câu, dưới 50 từ) phù hợp với đàm thoại giọng nói qua loa thông minh. Đầy đủ ý, nói thẳng vào trọng tâm câu hỏi của người dùng. Tuyệt đối không dùng ký tự markdown như *, #, ~, gạch đầu dòng.
XỬ LÝ TẠP ÂM: Nếu câu người dùng không rõ ràng hoặc có từ ngữ về đăng ký kênh/YouTube do nhận diện nhầm, chỉ cần vui vẻ nói: "Tôi đang lắng nghe bạn đây, bạn hãy nói lại nhé." Tuyệt đối không nhắc lại chuyện đăng ký kênh. ${weatherContext}` },
          { role: "user", content: userText }
        ];

        const llmResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
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
    // CỔNG 3: HTTP GET /tts - HOÀI MY NEURAL TTS (FALLBACK GOOGLE TTS)
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/tts") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing text parameter", { status: 400 });

      // Ưu tiên Hoài My Neural MP3
      try {
        const mp3Buffer = await fetchEdgeTTS(text, "vi-VN-HoaiMyNeural", "+0%", "audio-24khz-48kbitrate-mono-mp3");
        return new Response(mp3Buffer, { headers: { "Content-Type": "audio/mpeg" } });
      } catch (e) {
        console.warn("Hoai My TTS failed, fallback to Google TTS:", e.message);
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
    // CỔNG 4: HTTP GET /music - PROXY STREAM NHẠC MP3
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
    // CỔNG 5: TEST ENDPOINTS
    // --------------------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/test_chat") {
      return new Response("ESP32 AI Backend & WebSocket /ws is ready! Default voice: Hoai My Neural (Natural speed).", { status: 200 });
    }

    return new Response("ESP32 AI Backend Active! WebSocket: /ws, TTS: Hoai My Neural.", { status: 200 });
  }
};

// ==============================================================================
// XỬ LÝ PHIÊN WEBSOCKET CHO ESP32-S3 (HỖ TRỢ CHUẨN XIAOZHI & CUSTOM PROTOCOL)
// ==============================================================================
function handleWebSocketSession(server, env, initialRequest) {
  let audioChunks = []; // Lưu trữ chunks (PCM hoặc Opus)
  let isProcessing = false;
  let abortController = null;
  let conversationHistory = [];
  let isXiaozhiClient = false;
  let sessionId = "session_" + Date.now();
  let silenceTimer = null;
  let hasVoiceActivity = false;

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
            // Chuẩn bị file Audio gửi tới Groq Whisper
            let audioBlobFile;
            if (isXiaozhiClient) {
              // Client Xiaozhi gửi các gói raw Opus -> Đóng gói OGG Opus chuẩn RFC 7845
              const oggBuffer = opusPacketsToOgg(audioChunks, 16000);
              audioChunks = [];
              audioBlobFile = new File([oggBuffer], "audio.ogg", { type: "audio/ogg" });
            } else {
              // Client cũ gửi raw PCM 16-bit 16kHz
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

            // BƯỚC 1: GROQ WHISPER STT SIÊU TỐC
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

            const lowerUser = userText.toLowerCase().replace(/[.,!?]/g, '').trim();

            // Lọc ảo giác Whisper TRƯỚC KHI gửi kết quả STT về màn hình
            const whisperHallucinations = [
              "đăng ký kênh", "đăng kí kênh", "dang ky kenh", "subscribe", "sub kênh", "like và sub",
              "ủng hộ kênh", "hẹn gặp lại", "cảm ơn các bạn đã theo dõi", "cảm ơn đã theo dõi",
              "chúc các bạn", "video sau", "mời các bạn đón xem", "kênh của mình",
              "chia sẻ video", "hãy subscribe", "like và chia sẻ", "bấm chuông",
              "quý vị và các bạn", "chào mừng các bạn", "hẹn gặp lại quý vị", "đón xem video",
              "ghiền mì gõ", "ghien mi go", "tạm biệt và hẹn gặp lại", "hẹn gặp lại các bạn",
              "chúc bạn một ngày tốt lành", "hẹn gặp lại ở video sau"
            ];
            if (whisperHallucinations.some(h => lowerUser.includes(h))) {
              console.log("[Whisper Hallucination Filtered]:", userText);
              sendJSON({ type: "state", state: "listening" });
              isProcessing = false;
              return;
            }

            // Bắn kết quả STT về ESP32 hiển thị lên màn hình KHI ĐÃ XÁC NHẬN KHÔNG PHẢI ẢO GIÁC
            sendJSON({ type: "stt", text: userText });

            // Kiểm tra lệnh tắt nhạc / dừng nhạc
            const stopMusicKeywords = ["tắt nhạc", "tat nhac", "dừng nhạc", "dung nhac", "ngừng nhạc", "ngung nhac"];
            const isStopMusic = stopMusicKeywords.some(w => lowerUser.includes(w));

            if (isStopMusic) {
              sendJSON({ type: "music", action: "stop" });
              sendJSON({ type: "tts", state: "start" });
              sendJSON({ type: "state", state: "speaking" });
              await speakSentence("Tôi đã tắt nhạc rồi bạn nhé.", sendJSON, sendBinary, isXiaozhiClient, signal);
              sendJSON({ type: "tts", state: "stop" });
              sendJSON({ type: "state", state: "listening" });
              isProcessing = false;
              return;
            }

            // Kiểm tra yêu cầu mở nhạc
            const musicKeywords = [
              "hát", "hát đi", "hát một bài", "hát bài", "ca một bài",
              "mở bài", "bật bài", "phát bài", "nghe bài", "mở nhạc",
              "bật nhạc", "phát nhạc", "chơi bài", "chơi nhạc", "bài hát",
              "nghe nhạc", "play", "music", "song"
            ];
            const isMusic = musicKeywords.some(w => lowerUser.includes(w));

            if (isMusic) {
              let musicTitle = "Nhạc Trẻ V-Pop";
              let musicUrl = "https://stream.zeno.fm/0r0xa792kwzuv";

              if (lowerUser.includes("lofi") || lowerUser.includes("chill") || lowerUser.includes("thư giãn") || lowerUser.includes("ngủ")) {
                musicTitle = "Nhạc Lofi Chill";
                musicUrl = "https://stream.zeno.fm/f3wvbbqmdg8uv";
              } else if (lowerUser.includes("piano") || lowerUser.includes("không lời") || lowerUser.includes("giao hưởng")) {
                musicTitle = "Nhạc Piano Thư Giãn";
                musicUrl = "https://streams.ilovemusic.de/iloveradio26.mp3";
              } else if (lowerUser.includes("dance") || lowerUser.includes("edm") || lowerUser.includes("sôi động") || lowerUser.includes("tiếng anh")) {
                musicTitle = "Nhạc EDM Sôi Động";
                musicUrl = "https://streams.ilovemusic.de/iloveradio17.mp3";
              }

              const confirmText = `Tôi đang mở ${musicTitle.toLowerCase()} cho bạn đây, chúc bạn nghe nhạc vui vẻ nhé!`;
              sendJSON({ type: "tts", state: "start" });
              sendJSON({ type: "state", state: "speaking" });
              await speakSentence(confirmText, sendJSON, sendBinary, isXiaozhiClient, signal);
              sendJSON({ type: "tts", state: "stop" });

              // Phát tín hiệu mở nhạc đến ESP32
              sendJSON({
                type: "music",
                action: "play",
                title: musicTitle,
                url: musicUrl
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

            // Kiểm tra câu dừng / tạm biệt
            const exitKeywords = ["tạm biệt", "tam biet", "bye", "dừng lại", "dung lai", "kết thúc", "ket thuc", "thôi nha", "thôi nhé", "nghỉ thôi", "đủ rồi"];
            const isExit = exitKeywords.some(w => lowerUser.includes(w));

            // BƯỚC 2: STREAMING GROQ LLM (Qwen)
            sendJSON({ type: "tts", state: "start" });
            sendJSON({ type: "state", state: "speaking" });

            let weatherContext = await getWeatherAndContext(initialRequest);
            const systemPrompt = `Bạn là trợ lý ảo AI thông minh, vui vẻ và tự nhiên.
QUY TẮC BẮT BUỘC: Bạn với tui. Luôn xưng "tôi" và gọi người dùng là "bạn". Tuyệt đối không dùng anh/chị hay dạ/thưa.
VỊ TRÍ MẶC ĐỊNH: Nhà của bạn ở Biên Hòa, Đồng Nai. Khi người dùng hỏi thời tiết hoặc hỏi địa điểm mà không nói rõ ở đâu, luôn mặc định là thời tiết tại Biên Hòa.
Hãy trả lời ngắn gọn, cô đọng từ 1 đến 3 câu (dưới 45 từ) nói thẳng vào trọng tâm để tương tác mượt mà qua loa thông minh. Không dùng ký tự markdown như *, #. ${weatherContext}`;

            const messages = [
              { role: "system", content: systemPrompt },
              ...conversationHistory.slice(-4),
              { role: "user", content: userText }
            ];

            const llmRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.GROQ_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: messages,
                temperature: 0.7,
                max_tokens: 140,
                stream: true
              }),
              signal
            });

            if (!llmRes.ok || !llmRes.body) throw new Error("LLM Stream Failed");

            // BƯỚC 3: SENTENCE STREAMING & HOÀI MY NEURAL TTS
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

                    sendJSON({ type: "llm_delta", delta: delta });

                    if (hasSentenceBoundary(sentenceBuffer)) {
                      const sentenceToSpeak = cleanSentence(sentenceBuffer);
                      sentenceBuffer = "";

                      if (sentenceToSpeak.length > 1 && !signal.aborted) {
                        await speakSentence(sentenceToSpeak, sendJSON, sendBinary, isXiaozhiClient, signal);
                      }
                    }
                  }
                } catch (e) {}
              }
            }

            // Phần câu còn sót lại
            if (sentenceBuffer.trim().length > 0 && !signal.aborted) {
              const remainingSentence = cleanSentence(sentenceBuffer);
              if (remainingSentence.length > 1) {
                await speakSentence(remainingSentence, sendJSON, sendBinary, isXiaozhiClient, signal);
              }
            }

            if (!signal.aborted && accumulatedAiText.trim()) {
              conversationHistory.push({ role: "user", content: userText });
              conversationHistory.push({ role: "assistant", content: accumulatedAiText.trim() });
              if (conversationHistory.length > 6) conversationHistory.splice(0, 2);
            }

            sendJSON({ type: "tts", state: "stop" });
            sendJSON({
              type: "done",
              user_text: userText,
              ai_text: accumulatedAiText.trim(),
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

  server.addEventListener("message", async (event) => {
    // 1. DỮ LIỆU NHỊ PHÂN: AUDIO PACKETS TỪ MICRO (OPUS HOẶC PCM)
    if (event.data instanceof ArrayBuffer) {
      if (isProcessing) return;
      if (event.data.byteLength > 0) {
        audioChunks.push(new Uint8Array(event.data));

        // Phát hiện tiếng nói nếu gói Opus có dung lượng > 20 byte
        if (event.data.byteLength > 20) {
          hasVoiceActivity = true;
        }

        // Tự động nhận diện khi người dùng nói xong (Auto-VAD: 1.1s im lặng sau khi có tiếng nói)
        if (hasVoiceActivity && audioChunks.length >= 10) {
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            console.log("[Auto-VAD]: User paused speaking, processing...");
            finishAndProcessAudio();
          }, 1100);
        }

        // Giới hạn an toàn tối đa 10 giây nói liên tục (~160 gói * 60ms)
        if (audioChunks.length >= 160) {
          if (silenceTimer) clearTimeout(silenceTimer);
          console.log("[Auto-VAD]: Max recording limit reached, processing...");
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

        // B. KEEP-ALIVE PING
        if (msg.type === "ping") {
          sendJSON({ type: "pong", ts: Date.now() });
          return;
        }

        // C. BẮT ĐẦU LƯỢT NÓI (START / LISTEN: START)
        if (msg.type === "start" || (msg.type === "listen" && msg.state === "start")) {
          if (silenceTimer) clearTimeout(silenceTimer);
          audioChunks = [];
          hasVoiceActivity = false;
          sendJSON({ type: "state", state: "listening" });
          return;
        }

        // D. LỆNH CẮT NGANG (BARGE-IN / ABORT)
        if (msg.type === "abort") {
          if (silenceTimer) clearTimeout(silenceTimer);
          if (abortController) {
            abortController.abort();
            abortController = null;
          }
          audioChunks = [];
          hasVoiceActivity = false;
          isProcessing = false;
          sendJSON({ type: "state", state: "idle", interrupted: true });
          if (isXiaozhiClient) {
            sendJSON({ type: "tts", state: "stop" });
          }
          return;
        }

        // E. KẾT THÚC GIỌNG NÓI (STOP / LISTEN: STOP / AUDIO_END)
        if (msg.type === "audio_end" || msg.type === "stop" || (msg.type === "listen" && msg.state === "stop")) {
          finishAndProcessAudio();
          return;
        }
      } catch (err) {
        sendJSON({ type: "error", message: "Invalid JSON control packet" });
      }
    }
  });

  server.addEventListener("close", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (abortController) abortController.abort();
    audioChunks = [];
  });

  server.addEventListener("error", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (abortController) abortController.abort();
  });
}

// ==============================================================================
// PHÁT ÂM THANH CHO TỪNG CÂU (HOÀI MY NEURAL TTS)
// ==============================================================================
async function speakSentence(text, sendJSON, sendBinary, isXiaozhi, signal) {
  try {
    // Thông báo bắt đầu câu này -> Hiển thị text lên màn hình
    sendJSON({ type: "tts", state: "sentence_start", text: text });

    if (isXiaozhi) {
      // Dành cho Xiaozhi: Tạo Opus 16kHz -> Tách các gói Opus -> Bắn về ESP32
      try {
        const oggOpusBuffer = await fetchEdgeTTS(text, "vi-VN-HoaiMyNeural", "+0%", "audio-16khz-32kbitrate-mono-opus", signal);
        if (signal.aborted) return;
        const opusPackets = extractOpusPacketsFromOgg(oggOpusBuffer);
        for (const pkt of opusPackets) {
          if (signal.aborted) break;
          sendBinary(pkt);
        }
        return;
      } catch (e) {
        console.warn("[Edge-TTS Opus failed]:", e.message);
      }
    }

    // Dự phòng / Client thường: Tạo MP3 Hoài My hoặc Google TTS
    try {
      const mp3Buffer = await fetchEdgeTTS(text, "vi-VN-HoaiMyNeural", "+0%", "audio-24khz-48kbitrate-mono-mp3", signal);
      if (signal.aborted) return;
      sendBinary(mp3Buffer);
    } catch (e) {
      console.warn("[Edge-TTS MP3 failed, fallback Google]:", e.message);
      const googleMp3 = await fetchGoogleTTS(text, signal);
      if (signal.aborted) return;
      sendBinary(googleMp3);
    }

  } catch (err) {
    console.error("[speakSentence error]:", err.message);
  }
}

function hasSentenceBoundary(str) {
  if (str.length > 45) return true;
  return /[.,!?;:\n]/.test(str);
}

function cleanSentence(str) {
  return str.replace(/[*_#~]/g, '').trim();
}

// ==============================================================================
// MICROSOFT EDGE NEURAL TTS (HOÀI MY - vi-VN-HoaiMyNeural)
// ==============================================================================
async function fetchEdgeTTS(text, voice = "vi-VN-HoaiMyNeural", rate = "+0%", format = "audio-16khz-32kbitrate-mono-opus", signal = null) {
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EA654081836B88BA8BA368CE&ConnectionId=${connectionId}`;

  const resp = await fetch(url, {
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
    }
  });

  const ws = resp.webSocket;
  if (!ws) throw new Error("Edge TTS WebSocket upgrade failed");
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
// TRÍCH XUẤT RAW OPUS PACKETS TỪ OGG CONTAINER CỦA EDGE-TTS
// ==============================================================================
function extractOpusPacketsFromOgg(oggBuffer) {
  const uint8 = new Uint8Array(oggBuffer);
  const packets = [];
  let offset = 0;
  let pageIndex = 0;

  while (offset + 27 <= oggBuffer.byteLength) {
    if (uint8[offset] !== 0x4f || uint8[offset+1] !== 0x67 || uint8[offset+2] !== 0x67 || uint8[offset+3] !== 0x53) {
      offset++;
      continue;
    }
    const numSegments = uint8[offset + 26];
    if (offset + 27 + numSegments > oggBuffer.byteLength) break;

    const segmentTable = [];
    let bodySize = 0;
    for (let i = 0; i < numSegments; i++) {
      const segLen = uint8[offset + 27 + i];
      segmentTable.push(segLen);
      bodySize += segLen;
    }

    const bodyOffset = offset + 27 + numSegments;
    if (bodyOffset + bodySize > oggBuffer.byteLength) break;

    let curOffset = bodyOffset;
    let packetParts = [];

    for (let i = 0; i < numSegments; i++) {
      const segLen = segmentTable[i];
      if (pageIndex >= 2 && segLen > 0) {
        packetParts.push(uint8.subarray(curOffset, curOffset + segLen));
      }
      curOffset += segLen;
      if (segLen < 255) {
        if (pageIndex >= 2 && packetParts.length > 0) {
          let totalLen = 0;
          for (const p of packetParts) totalLen += p.byteLength;
          const pkt = new Uint8Array(totalLen);
          let pOff = 0;
          for (const p of packetParts) {
            pkt.set(p, pOff);
            pOff += p.byteLength;
          }
          packets.push(pkt.buffer);
        }
        packetParts = [];
      }
    }

    pageIndex++;
    offset = bodyOffset + bodySize;
  }
  return packets;
}

// ==============================================================================
// ĐÓNG GÓI CÁC GÓI OPUS THÀNH FILE OGG OPUS CHUẨN CHO GROQ WHISPER
// ==============================================================================
const OGG_CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) {
    r = (r & 0x80000000) ? (((r << 1) ^ 0x04c11db7) >>> 0) : ((r << 1) >>> 0);
  }
  OGG_CRC_TABLE[i] = r;
}

function oggChecksum(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc;
}

function opusPacketsToOgg(packets, sampleRate = 16000) {
  const serial = 0x12345678;
  const pages = [];

  function createPage(headerType, granulePos, pageSeq, packetData) {
    const u8Data = new Uint8Array(packetData);
    const numSegments = Math.ceil(u8Data.byteLength / 255) || 1;
    const headerLen = 27 + numSegments;
    const pageBuf = new Uint8Array(headerLen + u8Data.byteLength);
    const view = new DataView(pageBuf.buffer);

    pageBuf[0] = 0x4f; pageBuf[1] = 0x67; pageBuf[2] = 0x67; pageBuf[3] = 0x53; // "OggS"
    pageBuf[4] = 0;
    pageBuf[5] = headerType;
    view.setBigUint64(6, BigInt(granulePos), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, pageSeq, true);
    view.setUint32(22, 0, true);
    pageBuf[26] = numSegments;

    let rem = u8Data.byteLength;
    for (let i = 0; i < numSegments; i++) {
      const segLen = Math.min(rem, 255);
      pageBuf[27 + i] = segLen;
      rem -= segLen;
    }

    pageBuf.set(u8Data, headerLen);
    const crc = oggChecksum(pageBuf);
    view.setUint32(22, crc, true);
    return pageBuf;
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

async function getWeatherAndContext(request) {
  try {
    const city = "Biên Hòa, Đồng Nai";
    const lat = 10.9454;
    const lon = 106.8243;
    const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m`);
    let outsideInfo = "";
    if (weatherRes.ok) {
      const wData = await weatherRes.json();
      outsideInfo = `Thời tiết ngoài trời tại nhà bạn ở Biên Hòa: ${wData.current.temperature_2m}°C, độ ẩm ${wData.current.relative_humidity_2m}%. `;
    }
    const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "full", timeStyle: "short" });
    return `(Nhà bạn ở Biên Hòa, Đồng Nai. Thời gian hiện tại: ${now}. ${outsideInfo})`;
  } catch (e) {
    return "(Nhà bạn ở Biên Hòa, Đồng Nai.)";
  }
}
