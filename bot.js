const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const Bottleneck = require("bottleneck");

// إعداد الـ limiter لتقليل عدد الطلبات
const limiter = new Bottleneck({
  minTime: 60000, // 1 طلب كل 6 ثواني
});

const getWithLimit = (url, options) => {
  return limiter.schedule(() => axios.get(url, options));
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const mpcPath = '"c:\\Program Files (x86)\\MPC-HC\\mpc-hc.exe"';
const soundPath = path.join(__dirname, "alert.mp3");

// === CONFIGURATION ===
const TELEGRAM_TOKEN = "";
const CHECK_INTERVAL_MINUTES = 3;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const userSessions = {}; // { chatId: { wassit, identity } }

// === INITIALIZE BOT ===
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const message = "أرسل معلوماتك هكذا:\n/login 2839xx002760 10996103xxx27xx003";
  bot.sendMessage(msg.chat.id, message);
  console.log(`📩 [${msg.chat.id}] /start → ${message}`);
});

bot.onText(/\/login (\d{12}) (\d{18})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const wassit = match[1];
  const identity = match[2];

  userSessions[chatId] = { wassit, identity };

  const saveMsg =
    "✅ تم الحفظ. سيتم التحقق من مواعيدك كل " +
    CHECK_INTERVAL_MINUTES +
    " دقيقة.";
  bot.sendMessage(chatId, saveMsg);
  console.log(`📩 [${chatId}] /login → ${saveMsg}`);

  await checkAppointment(chatId, wassit, identity);
});

bot.onText(/\/tamdid (\d{12}) (\d{18})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const wassit = match[1];
  const identity = match[2];

  bot.sendMessage(chatId, "📤 جاري إرسال طلب التمديد...");

  try {
    const payload = {
      nin: identity,
      numeroWassit: wassit,
    };

    const res = await axios.put(
      "https://wassitonline.anem.dz/api/extendMyDemandePublic",
      payload,
      { httpsAgent }
    );

    const result = res.data.Result;
    const expireAfter = result.expireAfter;
    const anticipatedExpirationDate = result.anticipatedExpirationDate;

    const formattedDate = anticipatedExpirationDate.split("T")[0]; // YYYY-MM-DD

    await bot.sendMessage(
      chatId,
      `✅ تم تمديد الطلب بنجاح.
      📆 عدد الأيام المتبقية: ${expireAfter}
      ⏳ ينتهي في: ${formattedDate}
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: " تنزيل  بطاقتك",
                callback_data: `downloadFile|${wassit}|${identity}|${formattedDate}`,
              },
            ],
          ],
        },
      }
    );

    console.log("✅ تمديد تم بنجاح:", result);
  } catch (error) {
    console.error("❌ خطأ أثناء التمديد:", error.message);
    await bot.sendMessage(chatId, `❌ حدث خطأ: ${error.message}`);
  }
});

bot.onText(/\/getdate (\d{12}) (\d{18}) (\d{12})/, async (msg, match) => {
  const chatId = msg.chat.id;
  const wassit = match[1];
  const identity = match[2];
  const ccp = match[3];
  bot.sendMessage(
    chatId,
    "🔍 جاري التحقق من أهليتك والحجز إن وُجد تاريخ متاح..."
  );
  getAppointment(chatId, wassit, identity, ccp);
});
// === MAIN CHECK FUNCTION ===
const checkAppointment = async (chatId, wassit, identity) => {
  try {
    const mainUrl = `https://ac-controle.anem.dz/AllocationChomage/api/validateCandidate/query?wassitNumber=${wassit}&identityDocNumber=${identity}`;
    const mainRes = await getWithLimit(mainUrl, { httpsAgent });
    const data = mainRes.data;


    if (!data.eligible) {
      const msg = "❌ الشخص غير مؤهل لمنحة البطالة.";
      await bot.sendMessage(chatId, msg);
      console.log(`📩 [${chatId}] → ${msg}`);
      delete userSessions[chatId];
      return;
    }

    const preId = data.preInscriptionId;
    const structureId = data.structureId;
    let fullName = "";
    let structure = "";

    if (preId) {
      const preUrl = `https://ac-controle.anem.dz/AllocationChomage/api/PreInscription/GetPreInscription?Id=${preId}`;
      const preRes = await getWithLimit(preUrl, { httpsAgent });
      console.log(preRes.data);
      const info = preRes.data;
      fullName = `${info.prenomDemandeurFr} ${info.nomDemandeurFr}`;
      structure = info.structureAr;
    }

    const now = new Date();
    let needsNewAppointment = false;

    if (!data.haveRendezVous) {
      needsNewAppointment = true;
    } else {
      const rdvId = data.rendezVousId;
      if (rdvId) {
        const rdvUrl = `https://ac-controle.anem.dz/AllocationChomage/api/RendezVous/GetRendezVousInfosForPut?RendezVousId=${rdvId}`;
        const rdvRes = await getWithLimit(rdvUrl, { httpsAgent });
        const rdvData = rdvRes.data;

        const rdvDate = new Date(rdvData.rdvdate);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const endDate = new Date("2025-05-30");
        if (rdvDate >= tomorrow && rdvDate > endDate) {
          const msg = `📌 لديك موعد بالفعل في التاريخ: ${rdvDate
            .toISOString()
            .slice(0, 10)}`;
          await bot.sendMessage(chatId, msg);
          console.log(`📩 [${chatId}] → ${msg}`);
          delete userSessions[chatId]; // حذف الجلسة بعد إرسال الرسالة
          return;
        } else {
          needsNewAppointment = true; // الموعد قديم أو بعد 30 ماي
        }
      } else {
        needsNewAppointment = true;
      }
    }

    if (needsNewAppointment) {
      const availUrl = `https://ac-controle.anem.dz/AllocationChomage/api/RendezVous/GetAvailableDates?StructureId=${structureId}&PreInscriptionId=${preId}`;
      const availRes = await getWithLimit(availUrl, { httpsAgent });
      const availableDates = availRes.data.dates;

      if (availableDates.length > 0) {
        const firstDate = availableDates[0].split("T")[0]; // YYYY-MM-DD
        const formatted = availableDates.map((d) => `📅 ${d}`).join("\n");
        const msg = `
👤 طالب العمل: ${fullName}
🏢 الوكالة: ${structure}
📅 أقرب موعد: ${firstDate}
`;

        await bot.sendMessage(chatId, msg, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ احجز الآن",
                  // callback_data: `bookNow|${preId}|${structureId}`,
                },
              ],
            ],
          },
        });
        exec(`${mpcPath} "${soundPath}"`, (error) => {
          if (error) {
            console.error("❌ فشل تشغيل الصوت مع MPC:", error.message);
          }
        });
        console.log(`📩 [${chatId}] → ${msg}`);
      } else {
        const msg = `
👤 طالب العمل: ${fullName}
🏢 الوكالة: ${structure}
📅 أقرب موعد: لا يوجد موعد متاح حاليًا.
`;
        await bot.sendMessage(chatId, msg, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📅 تفعيل الحجز التلقائي لاحقًا",
                  // callback_data: `autoBook|${wassit}|${identity}`,
                },
              ],
            ],
          },
        });

        console.log(`📩 [${chatId}] → ${msg}`);
      }
    } else {
      console.log(`✅ ${fullName} لديه موعد ساري. لا حاجة لحجز جديد الآن.`);
    }
  } catch (error) {
    console.error("❌ حدث خطأ:", error.message);
    const errorMsg = `⚠️ خطأ أثناء التحقق: ${error.message}`;
    // await bot.sendMessage(chatId, errorMsg);
    console.log(`📩 [${chatId}] → ${errorMsg}`);
  }
};

const getAppointment = async (chatId, wassit, identity, ccp) => {
  try {
    const mainUrl = `https://ac-controle.anem.dz/AllocationChomage/api/validateCandidate/query?wassitNumber=${wassit}&identityDocNumber=${identity}`;
    const mainRes = await axios.get(mainUrl, { httpsAgent });
    const data = mainRes.data;

    if (!data.eligible) {
      const msg = "❌ الشخص غير مؤهل لمنحة البطالة.";
      await bot.sendMessage(chatId, msg);
      console.log(`📩 [${chatId}] → ${msg}`);
      delete userSessions[chatId];
      return;
    }

    const preId = data.preInscriptionId;
    const structureId = data.structureId;
    const demandeurId = data.demandeurId;
    const rdvId = data.rendezVousId;

    let fullName = "";
    let fName = "";
    let lName = "";
    let structure = "";

    if (preId) {
      const preUrl = `https://ac-controle.anem.dz/AllocationChomage/api/PreInscription/GetPreInscription?Id=${preId}`;
      const preRes = await axios.get(preUrl, { httpsAgent });
      const info = preRes.data;
      fullName = `${info.prenomDemandeurFr} ${info.nomDemandeurFr}`;
      lName = `${info.prenomDemandeurFr}`;
      fName = `${info.nomDemandeurFr}`;
      structure = info.structureAr;
    }

    const now = new Date();
    let needsNewAppointment = false;

    if (!data.haveRendezVous) {
      needsNewAppointment = true;
    } else {
      if (rdvId) {
        const rdvUrl = `https://ac-controle.anem.dz/AllocationChomage/api/RendezVous/GetRendezVousInfosForPut?RendezVousId=${rdvId}`;
        const rdvRes = await axios.get(rdvUrl, { httpsAgent });
        const rdvData = rdvRes.data;
        const rdvDate = new Date(rdvData.rdvdate);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const endDate = new Date("2025-05-30");
        if (rdvDate >= tomorrow && rdvDate > endDate) {
          const msg = `📌 لديك موعد بالفعل في التاريخ: ${rdvDate
            .toISOString()
            .slice(0, 10)}`;
          await bot.sendMessage(chatId, msg);
          console.log(`📩 [${chatId}] → ${msg}`);
          needsNewAppointment = true; // الموعد قديم أو بعد 30 ماي
          //return;
        } else {
          needsNewAppointment = true; // الموعد قديم أو بعد 30 ماي
        }
      } else {
        /// لا يوجد موعدid
        needsNewAppointment = true;
      }
    }

    if (needsNewAppointment) {
      const availUrl = `https://ac-controle.anem.dz/AllocationChomage/api/RendezVous/GetAvailableDates?StructureId=${structureId}&PreInscriptionId=${preId}`;
      const availRes = await axios.get(availUrl, { httpsAgent });
      const availableDates = availRes.data.dates;

      if (availableDates.length > 0) {
        const rawDate = availableDates[0]; // e.g., "27/07/2025"
        const [day, month, year] = rawDate.split("/");
        const firstDate = `${year}-${month}-${day}`; // "2025-07-27"
        ///جاري الحجز
        const msg = `📌 جاري حجز الموعد لـ ${fName} ${lName} في ${firstDate}`;
        bot.sendMessage(chatId, msg);

        const bookingPayload = {
          rendezVousId: rdvId,
          ccp: ccp,
          nomCcp: fName,
          prenomCcp: lName,
          demandeurId: demandeurId,
          rdvdate: "2025-06-30",
        };
        try {
          const bookingRes = await axios.put(
            "https://ac-controle.anem.dz/AllocationChomage/api/RendezVous/Put",
            bookingPayload,
            { httpsAgent }
          );
          const msg = `✅ تم حجز الموعد بنجاح لـ ${fName} ${lName} في ${firstDate}`;
          await bot.sendMessage(chatId, msg);
          console.log(`📩 [${chatId}] → ${msg}`);
        } catch (error) {
          console.error("❌ حدث خطأ أثناء الحجز:", error.message);
          const errorMsg = `⚠️ خطأ أثناء الحجز: ${error.message}`;
          await bot.sendMessage(chatId, errorMsg);
        }

        bot.sendMessage(chatId, "تم الحجز بنجاح");
        console.log(`📩 [${chatId}] → ${msg}`);
      } else {
        const msg = `⏳ لا توجد مواعيد متاحة لـ ${fullName} في ${structure}.`;
        await bot.sendMessage(chatId, msg);
        console.log(`📩 [${chatId}] → ${msg}`);
      }
    } else {
      console.log(`✅ ${fullName} لديه موعد ساري. لا حاجة لحجز جديد الآن.`);
    }
  } catch (error) {
    console.error("❌ حدث خطأ:", error.message);
    const errorMsg = `⚠️ خطأ أثناء التحقق: ${error.message}`;
    // await bot.sendMessage(chatId, errorMsg);
    console.log(`📩 [${chatId}] → ${errorMsg}`);
  }
};

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    if (data.startsWith("bookNow")) {
      const [, preId, structureId] = data.split("|");
      await bot.sendMessage(chatId, "⏳ جاري محاولة الحجز الآن...");
      // await tryBooking(preId, structureId, chatId);
    }
    if (data.startsWith("downloadFile")) {
      const [, wassit, identity, formattedDate] = data.split("|");
      await bot.sendMessage(chatId, "📤 جاري تنزيل الوثيقة الخاصة بك...");
      const ficheRes = await axios.get(
        `https://wassitonline.anem.dz/api/FicheDemandeurOnline?nin=${identity}&numeroWassit=${wassit}`,
        { responseType: "text", httpsAgent }
      );

      const base64Data = ficheRes.data;
      const pdfBuffer = Buffer.from(base64Data, "base64");
      const pdfFileName = `f_${wassit} ${formattedDate}.pdf`;
      const pdfFilePath = path.join(__dirname, pdfFileName);
      fs.writeFileSync(pdfFilePath, pdfBuffer);
      await bot.sendDocument(chatId, pdfFilePath, {
        caption: "📄 الوثيقة الخاصة بك",
      });

      fs.unlinkSync(pdfFilePath); // حذف الملف بعد الإرسال
    }

    if (data.startsWith("autoBook")) {
      const [, wassit, identity] = data.split("|");
      userSessions[chatId] = { wassit, identity };
      await bot.sendMessage(
        chatId,
        "✅ تم تفعيل الحجز التلقائي. سنقوم بإعلامك عند توفر موعد."
      );
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("❌ خطأ في :", err.message);
    await bot.answerCallbackQuery(query.id, {
      text: "❌ حدث خطأ أثناء المعالجة.",
      show_alert: true,
    });
  }
});


// === AUTO CHECK LOOP FOR ALL USERS ===
setInterval(async () => {
  try {
    for (const chatId in userSessions) {
      const { wassit, identity } = userSessions[chatId];
      await checkAppointment(chatId, wassit, identity);
    }
  } catch (error) {
    console.error("❌ حدث خطأ في الحلقة التلقائية:", error.message);
  }
}, CHECK_INTERVAL_MINUTES * 60 * 1000);
