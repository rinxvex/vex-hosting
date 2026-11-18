# vex-hosting: استضافة بوتات تلجرم (Node.js / Python / PHP)

موقع Node.js بدون مكتبات خارجية (مفيش npm install).

## التشغيل على HidenCloud
1. ارفع botnest.zip في Files واعمل Unarchive، وامسح الـ zip.
2. Startup > Main file: `src/server.js`
3. تأكد إن `.env` موجود (ملف مخفي) وعدّل منه SECRET وADMIN_EMAIL وADMIN_PASSWORD.
   الموقع مفيهوش تسجيل عام: أي حد يسجّل ويعمل سيرفرات (ALLOW_SIGNUP وALLOW_USER_CREATE، حط 0 للقفل).
4. Start، وافتح IP:PORT من تبويب Network.

## بوت التحكم في تلجرم
1. اعمل بوت من @BotFather وحط توكنه في `.env`: `CONTROL_BOT_TOKEN=...` وأعد تشغيل الموقع.
2. تسجيل الدخول من البوت: `/login الإيميل كلمة_السر` (الرسالة بتتمسح).
3. بعدها: `/bots` للتحكم، `/use اسم` لاختيار سيرفر، `/token` لتغيير التوكن. ابعت ZIP أو أي ملف وهيترفع، واللغة (Node/Python/PHP) بتتعرّف تلقائي.
4. المطورين (`DEV_TG_IDS` في `.env`): `/newaccount` `/newserver` `/accounts` `/adddev` `/deldev` `/devs`. الأوامر دي مش بتظهر لغيرهم.

## تشغيل محلي
    cp .env.example .env && node src/server.js

## اختبار
    node test/e2e.js

## تنبيهات
- مفيش عزل بين المستخدمين. استضف بوتات ناس بتثق فيهم بس.
- PHP شغال بمحاكاة webhook: المنصة بتسحب التحديثات وتشغّل php لكل رسالة.
- اللوحات المجانية ممكن تمسح الملفات، خد نسخة من مجلد data.

## بوتات واتساب
اعمل سيرفر جديد واختار المنصة "واتساب" (من غير توكن). ارفع ملفات البوت (Baileys وغيره)، شغّله، وهيظهر الـ QR أو كود الربط في الكونسول. تبويب "ربط واتساب" فيه حالة الجلسة ومسحها وحفظ الرقم (PHONE_NUMBER). الجلسة بتتحفظ في ملفات السيرفر.
