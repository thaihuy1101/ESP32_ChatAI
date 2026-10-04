export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -------------------------------------------------------------
    // ROUTE 1: Nhận âm thanh, chuyển thành Text và đưa cho AI nghĩ
    // -------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/chat") {
      const GROQ_API_KEY = env.GROQ_API_KEY;

      try {
        const audioBuffer = await request.arrayBuffer();
        
        const formData = new FormData();
        formData.append("file", new File([audioBuffer], "audio.wav", { type: "audio/wav" }));
        formData.append("model", "whisper-large-v3-turbo"); 
        formData.append("language", "vi");
        formData.append("response_format", "json");

        // 1. STT
        const sttResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GROQ_API_KEY}` },
          body: formData
        });

        if (!sttResponse.ok) throw new Error(`STT Failed (Size ${audioBuffer.byteLength}): ${await sttResponse.text()}`);
        
        const sttData = await sttResponse.json();
        const userText = sttData.text || "";

        if (!userText.trim()) return new Response(JSON.stringify({ error: "No speech" }), { status: 400 });

        // 2. LLM
        const llmResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            messages: [
              {
                role: "system",
                content: "Bạn là trợ lý AI. Hãy trả lời cực kỳ ngắn gọn, tự nhiên, dưới 25 từ."
              },
              { role: "user", content: userText }
            ],
            temperature: 0.7,
            max_tokens: 150
          })
        });

        if (!llmResponse.ok) throw new Error(`LLM Failed`);

        const llmData = await llmResponse.json();
        let aiText = llmData.choices[0].message.content.trim();
        // Xóa ký tự đặc biệt
        aiText = aiText.replace(/[*_#~]/g, '');

        // Trả về JSON cho ESP32
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

    // -------------------------------------------------------------
    // ROUTE 2: GET yêu cầu tạo giọng nói (TTS)
    // -------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/tts") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing text parameter", { status: 400 });

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

    return new Response("ESP32 AI Backend is running!", { status: 200 });
  }
};
