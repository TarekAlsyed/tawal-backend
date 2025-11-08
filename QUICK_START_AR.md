# 🚀 البدء السريع - Tawal Academy Backend

## ⚡ 3 خطوات فقط للبدء

### 1️⃣ تثبيت المكتبات
```bash
npm install
```

### 2️⃣ تشغيل الخادم
```bash
npm start
```

ستظهر رسالة:
```
✓ الخادم يعمل على: http://localhost:3001
```

### 3️⃣ اختبر الخادم
افتح المتصفح:
```
http://localhost:3001/api/health
```

---

## 📤 رفع على GitHub في 5 دقائق

### الخطوة 1: تثبيت Git
- Windows: https://git-scm.com/download/win
- Mac: https://git-scm.com/download/mac
- Linux: `sudo apt install git`

### الخطوة 2: إنشاء حساب GitHub
- اذهبي إلى: https://github.com/signup
- أنشئي حساباً جديداً

### الخطوة 3: إنشاء مستودع
1. اضغطي على `+` في الزاوية العلوية اليمنى
2. اختاري `New repository`
3. أدخلي الاسم: `tawal-academy-backend`
4. اختاري `Public`
5. اضغطي `Create repository`

### الخطوة 4: رفع الملفات
انسخي هذه الأوامر في Terminal/Command Prompt:

```bash
cd /path/to/tawal_backend
git init
git add .
git commit -m "Initial commit - Tawal Academy Backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tawal-academy-backend.git
git push -u origin main
```

**استبدلي `YOUR_USERNAME` باسم حسابك على GitHub**

---

## 🌍 نشر على الإنترنت

### الخيار 1: Heroku (الأسهل)

```bash
# تثبيت Heroku CLI من: https://devcenter.heroku.com/articles/heroku-cli

heroku login
heroku create tawal-academy-backend
git push heroku main
```

**الرابط النهائي:**
```
https://tawal-academy-backend.herokuapp.com
```

### الخيار 2: Railway (الأسرع)

1. اذهبي إلى: https://railway.app
2. اضغطي: `Deploy from GitHub`
3. اختاري المستودع
4. اضغطي: `Deploy`

---

## 📝 استخدام الـ API

### تسجيل طالب جديد
```javascript
fetch('http://localhost:3001/api/students/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'أحمد محمد',
    email: 'ahmed@example.com'
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

### حفظ نتيجة اختبار
```javascript
fetch('http://localhost:3001/api/quiz-results', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    studentId: 1,
    quizName: 'GIS Networks',
    score: 85,
    totalQuestions: 10,
    correctAnswers: 8
  })
})
.then(res => res.json())
.then(data => console.log(data));
```

### جلب نتائج الطالب
```javascript
fetch('http://localhost:3001/api/students/1/results')
  .then(res => res.json())
  .then(data => console.log(data));
```

---

## 🔗 الـ Endpoints الرئيسية

| الطلب | الـ Endpoint | الوصف |
|------|-----------|-------|
| POST | `/api/students/register` | تسجيل طالب جديد |
| GET | `/api/students/:id` | الحصول على بيانات الطالب |
| POST | `/api/quiz-results` | حفظ نتيجة اختبار |
| GET | `/api/students/:id/results` | جلب نتائج الطالب |
| GET | `/api/students/:id/stats` | جلب إحصائيات الطالب |
| POST | `/api/login` | تسجيل دخول |
| POST | `/api/logout` | تسجيل خروج |
| GET | `/api/admin/students` | جميع الطلاب (إدارة) |
| GET | `/api/admin/stats` | إحصائيات عامة (إدارة) |
| GET | `/api/admin/login-logs` | سجلات الدخول (إدارة) |

---

## ❓ المشاكل الشائعة

**المشكلة**: `npm: command not found`
**الحل**: تثبيت Node.js من https://nodejs.org/

**المشكلة**: `Port 3001 is already in use`
**الحل**: غيري المنفذ في `server.js` من 3001 إلى 3002

**المشكلة**: `CORS error`
**الحل**: CORS مفعل بالفعل، تأكدي من أن الخادم يعمل

---

## 📚 المزيد من المعلومات

للمزيد من التفاصيل، اقرأي: `README_AR.md`

---

**تم الإنشاء بواسطة**: Manus AI
**التاريخ**: 2025-11-08
