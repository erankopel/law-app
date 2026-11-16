# law-app — אפליקציית חיפוש משפטי פרטית

דף סטטי (index.html) + Cloudflare Worker (worker/worker.js) תחת law.medicom.vip/api/*.

- חיפוש פסיקה: הפרוקסי ל-/api/search של גילוי נאות (בלי מפתח ובלי מכסה).
- חקיקה: /api/laws של גילוי נאות; טקסט מלא מוויקיטקסט (ספר החוקים הפתוח) דרך /api/law-text.
- שאל AI: /api/ask — קלוד עם כלי חיפוש על אותם מקורות. דורש סודות ב-Worker: APP_PIN, ANTHROPIC_API_KEY.
- סימניות והערות: localStorage בדפדפן בלבד.

פריסה: GitHub Pages מהריפו הזה; ה-Worker נפרס דרך Cloudflare API ומחובר בנתיב law.medicom.vip/api/*.
