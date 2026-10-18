# 📱 KindleWebpageMaker — Standalone Android App

> A standalone native Android app that converts **GeeksForGeeks topics** and **PDF documents** directly on your Android phone into Kindle-ready EPUB ebooks.

---

## 🌟 How the Android App Works (100% In-App)

- **100% In-App & Offline-Capable**: The APK contains a built-in conversion engine. You do **not** need a PC or backend server running.
- **Native Android HTTP (Bypasses CORS)**: Uses `CapacitorHttp` (backed by Android OkHttp) to crawl and scrape GeeksForGeeks pages directly on your device without browser CORS blocks.
- **In-App PDF Parser**: Extracts text and structures chapters from PDF files directly in phone memory using `pdfjs-dist`.
- **Pure JavaScript EPUB Builder**: Generates valid Kindle EPUB 2.0 archives using `JSZip` in memory.
- **Direct Kindle Integration**: Saves EPUBs directly to your Android **Downloads** folder. Tapping the completed download opens it directly in the **Amazon Kindle for Android** app or any e-reader!
- **Optional PC/Remote Server**: Tap ⚙️ Settings inside the app if you want to connect to a PC server over Wi-Fi (`http://192.168.x.x:3001`).

---

## 🚀 How to Push Only This Folder to a Standalone GitHub Repo

This folder is **completely self-contained**. You can initialize git directly in this folder and push only this folder to its own GitHub repository:

```bash
# 1. Enter the android port folder
cd "android port"

# 2. Initialize a new Git repository here
git init

# 3. Add all files and commit
git add .
git commit -m "Initial commit: Standalone KindleWebpageMaker Android App"

# 4. Set the default branch to main
git branch -M main

# 5. Link to your new GitHub repository
git remote add origin https://github.com/YOUR_USERNAME/YOUR_ANDROID_REPO.git

# 6. Push to GitHub
git push -u origin main
```

---

## ⚡ Automated Free APK Build via GitHub Actions

Because this folder includes `.github/workflows/build-apk.yml`, pushing to GitHub **automatically triggers GitHub Actions**:

1. After pushing to your repository, open the **Actions** tab on GitHub.
2. You will see the **"Build Android APK"** workflow running automatically.
3. In ~2 minutes, the workflow finishes compiling the native Android project.
4. Scroll down to **Artifacts** and download **`KindleWebpageMaker-debug.apk`** directly onto your phone!

---

## 🛠️ Local Build Options

### Option 1: Open in Android Studio
1. Open [Android Studio](https://developer.android.com/studio).
2. Select **Open** and choose the `android` folder inside this directory:
   ```
   android port/android
   ```
3. Click **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**.
4. Locate `app-debug.apk` and transfer it to your phone.

### Option 2: Command Line (Gradle)
If JDK 17 and Android SDK are installed in your terminal:
```bash
npm run build:all
cd android
./gradlew assembleDebug
```
The compiled APK will be at:
`android/app/build/outputs/apk/debug/app-debug.apk`

---

## 📲 Installing on Your Android Phone

1. Transfer or download `KindleWebpageMaker-debug.apk` onto your phone.
2. Tap the APK file in your phone's **Files** or **Downloads** app.
3. If prompted, toggle **"Allow from this source"** in Settings.
4. Tap **Install** and open **KindleWebpageMaker**.
5. Paste any GFG URL or upload a PDF document.
6. Tap **Convert** → Tap **Download EPUB**.
7. Tap the downloaded file and select **"Open with Kindle"** to start reading!
