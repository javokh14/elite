const WEB_APP_URL = "https://webstarss.netlify.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Worker ishlayotganini tekshirish
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Elite Stars Bot ishlayapti ✅");
    }

    // Webhookni Telegramga avtomatik ulash
    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/webhook`;

      const result = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            url: webhookUrl
          })
        }
      );

      const data = await result.json();

      return Response.json({
        webhook: webhookUrl,
        telegram: data
      });
    }

    // Telegram webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      const update = await request.json();

      try {
        await handleUpdate(update, env);
      } catch (error) {
        console.log(error);
      }

      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
};


async function handleUpdate(update, env) {

  const message = update.message;

  if (!message) return;

  const chatId = message.chat.id;

  // /start
  if (message.text?.startsWith("/start")) {

    const me = await telegram(env, "getMe");

    const botName =
      me.result?.first_name ||
      "Elite Stars";

    await telegram(env, "sendMessage", {
      chat_id: chatId,

      text:
`⭐ ${botName} botiga xush kelibsiz!

Botdan foydalanish uchun avval telefon raqamingizni tasdiqlang.

🇺🇿 Botdan faqat O‘zbekiston (+998) raqamli foydalanuvchilar foydalanishi mumkin.`,

      reply_markup: {
        keyboard: [
          [
            {
              text: "📱 Telefon raqamni yuborish",
              request_contact: true
            }
          ]
        ],

        resize_keyboard: true,
        one_time_keyboard: true
      }
    });

    return;
  }


  // CONTACT
  if (message.contact) {

    // Boshqa odam kontaktini yuborib bo'lmasin
    if (
      message.contact.user_id &&
      message.contact.user_id !== message.from.id
    ) {

      await telegram(env, "sendMessage", {
        chat_id: chatId,

        text:
          "❌ Faqat o‘zingizning Telegram telefon raqamingizni yuboring."
      });

      return;
    }


    let phone =
      message.contact.phone_number || "";

    phone =
      phone.replace(/[^\d+]/g, "");


    const isUzbek =
      phone.startsWith("+998") ||
      phone.startsWith("998");


    if (!isUzbek) {

      await telegram(env, "sendMessage", {
        chat_id: chatId,

        text:
`❌ Bu raqam O‘zbekiston raqami emas.

Botdan faqat 🇺🇿 +998 raqamli foydalanuvchilar foydalanishi mumkin.`,

        reply_markup: {
          keyboard: [
            [
              {
                text: "📱 Qayta yuborish",
                request_contact: true
              }
            ]
          ],

          resize_keyboard: true
        }
      });

      return;
    }


    await telegram(env, "sendMessage", {
      chat_id: chatId,

      text:
`✅ Telefon raqamingiz tasdiqlandi!

📢 Keyingi bosqichda majburiy kanallarga obuna bo‘lishingiz kerak.

Hozircha Web App test rejimida ochildi.`,

      reply_markup: {
        remove_keyboard: true
      }
    });


    await telegram(env, "sendMessage", {
      chat_id: chatId,

      text:
        "⭐ Botimizdan foydalanish uchun Web Panelga kiring:",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🌐 Web Appga kirish",
              web_app: {
                url: WEB_APP_URL
              }
            }
          ]
        ]
      }
    });

    return;
  }

}


async function telegram(env, method, body = {}) {

  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify(body)
    }
  );

  return response.json();
}
