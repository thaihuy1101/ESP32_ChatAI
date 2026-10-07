export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/chat") {
      const GROQ_API_KEY = env.GROQ_API_KEY;

      try {
        const audioBuffer = await request.arrayBuffer();
        
        const formData = new FormData();
        formData.append("file", new File([audioBuffer], "audio.wav", { type: "audio/wav" }));
        formData.append("model", "whisper-large-v3-turbo"); 
        formData.append("language", "vi");
        formData.append("response_format", "json");

        const sttResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: formData
        });

        if (!sttResponse.ok) throw new Error(`STT Failed`);
        const sttData = await sttResponse.json();
        const userText = sttData.text || "";

        if (!userText.trim()) return new Response(JSON.stringify({ error: "No speech" }), { status: 400 });

        // TỰ ĐỘNG LẤY THỜI TIẾT HIỆN TẠI VÀ PHÒNG
        let weatherContext = "";
        try {
            const roomTempHeader = request.headers.get("X-Room-Temp");
            let roomInfo = "";
            if (roomTempHeader) {
                const parts = roomTempHeader.split(",");
                if(parts.length === 2) {
                    roomInfo = `Nhiệt độ phòng hiện tại là ${parts[0]} độ C, độ ẩm ${parts[1]} phần trăm. `;
                }
            }
            
            const city = request.cf?.city || "Việt Nam"; // Lấy thành phố từ IP
            const lat = request.cf?.latitude || 21.0285;
            const lon = request.cf?.longitude || 105.8542;
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m`);
            let outsideInfo = "";
            if(weatherRes.ok) {
                const wData = await weatherRes.json();
                outsideInfo = `Nhiệt độ ngoài trời ở ${city} là ${wData.current.temperature_2m} độ C, độ ẩm ${wData.current.relative_humidity_2m} phần trăm.`;
            }
            if (roomInfo || outsideInfo) {
                weatherContext = `(Ghi chú: ${roomInfo}${outsideInfo})`;
            }
        } catch(e) {}

        const lastUserEnc = request.headers.get("X-Last-User");
        const lastAiEnc = request.headers.get("X-Last-AI");
        const msgList = [
          { role: "system", content: `Bạn là trợ lý ảo tên Groq. Hãy trả lời thân thiện, vui vẻ. BẮT BUỘC trả lời TỐI ĐA 2 CÂU và DƯỚI 30 TỪ để không bị tràn màn hình thiết bị. KHÔNG liệt kê dài dòng. ${weatherContext}` }
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
            model: "openai/gpt-oss-20b",
            messages: msgList,
            temperature: 0.7,
            max_tokens: 150
          })
        });

        if (!llmResponse.ok) throw new Error(`LLM Failed`);

        const llmData = await llmResponse.json();
        let aiText = llmData.choices[0].message.content.trim();
        aiText = aiText.replace(/[*_#~]/g, '');

        return new Response(JSON.stringify({
          user_text: userText,
          ai_text: aiText
        }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/tts") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing text parameter", { status: 400 });

      const FPT_API_KEY = env.FPT_API_KEY;
      if (FPT_API_KEY) {
        // Dùng API FPT AI TTS
        const fptRes = await fetch("https://api.fpt.ai/hmi/tts/v5", {
          method: "POST",
          headers: {
            "api-key": FPT_API_KEY,
            "voice": "banmai", 
            "speed": "0" 
          },
          body: text
        });

        if (!fptRes.ok) return new Response("FPT TTS Request Failed", { status: 500 });
        const fptData = await fptRes.json();
        const asyncUrl = fptData.async;

        // Polling để đợi file audio gen xong
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 200)); // Đợi 200ms mỗi vòng
          const audioRes = await fetch(asyncUrl);
          if (audioRes.ok) {
            const contentType = audioRes.headers.get("content-type") || "";
            if (contentType.includes("audio") || contentType.includes("mpeg") || contentType.includes("octet-stream")) {
              const mp3Buffer = await audioRes.arrayBuffer();
              return new Response(mp3Buffer, {
                headers: { "Content-Type": "audio/mpeg" }
              });
            }
          }
        }
        return new Response("FPT TTS Timeout", { status: 504 });
      } else {
        // Fallback lại Google Translate nếu chưa có FPT Key
        const encodedText = encodeURIComponent(text);
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodedText}`;

        const ttsResponse = await fetch(ttsUrl, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (!ttsResponse.ok) return new Response("TTS Failed", { status: 500 });

        const mp3Buffer = await ttsResponse.arrayBuffer();
        return new Response(mp3Buffer, {
          headers: { "Content-Type": "audio/mpeg" }
        });
      }
    }

    return new Response("ESP32 AI Backend is running!", { status: 200 });
  }
};
