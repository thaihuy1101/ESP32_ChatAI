export default {
  async fetch(request, env, ctx) {
    // Chỉ chấp nhận POST request (ESP32 gửi âm thanh lên)
    if (request.method !== "POST") {
      return new Response("Hello! ESP32 AI Backend is running. Please send a POST request.", { status: 200 });
    }

    const GROQ_API_KEY = env.GROQ_API_KEY;

    try {
      // 1. NHẬN FILE ÂM THANH (WAV) TỪ ESP32
      const audioBuffer = await request.arrayBuffer();
      
      // Tạo FormData để đẩy lên Groq Whisper
      const formData = new FormData();
      formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
      formData.append("model", "whisper-large-v3-turbo"); 
      formData.append("language", "vi"); // Ép hiểu tiếng Việt cho nhanh
      formData.append("response_format", "json");

      // 2. STT (SPEECH-TO-TEXT) QUA GROQ
      const sttResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: formData
      });

      if (!sttResponse.ok) {
        throw new Error(`STT Failed: ${await sttResponse.text()}`);
      }

      const sttData = await sttResponse.json();
      const userText = sttData.text || "";
      console.log("User said:", userText);

      // Nếu không nghe thấy gì
      if (!userText.trim()) {
         return new Response("No speech detected", { status: 400 });
      }

      // 3. LLM (TẠO CÂU TRẢ LỜI) QUA GROQ LLAMA 3
      const llmResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-70b-versatile",
          messages: [
            {
              role: "system",
              content: "Bạn là một AI thông minh tên là Gemini. Hãy trả lời cực kỳ ngắn gọn, tự nhiên, thân thiện và mang tính đối thoại. Chiều dài câu trả lời TỐI ĐA 25 từ (vì bị giới hạn công cụ chuyển đổi giọng nói)."
            },
            {
              role: "user",
              content: userText
            }
          ],
          temperature: 0.7,
          max_tokens: 150
        })
      });

      if (!llmResponse.ok) {
        throw new Error(`LLM Failed: ${await llmResponse.text()}`);
      }

      const llmData = await llmResponse.json();
      let aiText = llmData.choices[0].message.content.trim();
      console.log("AI said:", aiText);

      // 4. TTS (TEXT-TO-SPEECH) BẰNG GOOGLE TRANSLATE (FREE)
      // Loại bỏ các ký tự đặc biệt có thể làm lỗi URL
      const cleanAiText = aiText.replace(/[*_#~]/g, '');
      const encodedText = encodeURIComponent(cleanAiText);
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=${encodedText}`;

      const ttsResponse = await fetch(ttsUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
      });

      if (!ttsResponse.ok) {
        throw new Error("TTS Failed");
      }

      // Lấy file MP3 trả về từ Google
      const mp3Buffer = await ttsResponse.arrayBuffer();
      
      // 5. TRẢ KẾT QUẢ VỀ CHO ESP32 (BAO GỒM AUDIO MP3 VÀ TEXT ĐỂ HIỂN THỊ LÊN MÀN HÌNH)
      return new Response(mp3Buffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          // Truyền chuỗi text qua HTTP Header để mạch ESP32 lấy được và in ra màn hình
          "X-User-Text": encodeURIComponent(userText),
          "X-AI-Text": encodeURIComponent(cleanAiText)
        }
      });

    } catch (err) {
      console.error(err.message);
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  }
};
