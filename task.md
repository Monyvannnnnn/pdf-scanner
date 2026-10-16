# Project Summary & Today's Tasks

**Date:** October 16, 2026  
**Project:** DocumentScannerApp (Ionic + Angular + Capacitor)

---

## 1. Android CI/CD Setup & Fixes
* **Added Android Debug Workflow**: Added a dedicated Android workflow to `codemagic.yaml` to assemble debug APKs.
* **Fixed Permission Error (Exit Code 126)**:
  * *Problem*: In Windows Git, the Gradle wrapper script (`android/gradlew`) was saved without executable permissions (`100644`), which caused Codemagic builds to fail with "Permission denied".
  * *Fix*: Changed file mode in Git index to executable (`100755`) and added `chmod +x gradlew` directly to the build script.
* **Fixed Gradle Crash (Exit Code 1)**:
  * *Problem*: Gradle was set to version `9.7.1`, which dropped internal APIs needed by Android Gradle Plugin (AGP) `8.13.0`.
  * *Fix*: Downgraded Gradle wrapper from `9.7.1` to `8.13` in `android/gradle/wrapper/gradle-wrapper.properties` and configured Java 21 in `codemagic.yaml` to match Capacitor 8 requirements.

---

## 2. iOS CI/CD & Browser Quick Launch (App Preview)
* **Added iOS Simulator Workflow**: Configured Codemagic to build a simulator `.app` binary targeting `iphonesimulator` without code signing.
* **Integrated Quick Launch into Main iOS Workflow**:
  * Added the simulator compilation step directly into the main `Ionic Capacitor iOS` workflow.
  * Every time an iOS build runs, Codemagic now automatically produces:
    1. `App.ipa` (for physical iPhones).
    2. Simulator `.app` bundle (which enables the in-browser **Quick Launch** button on Codemagic).
* **Fixed Simulator Build Issues**: Added dynamic simulator destination detection (`platform=iOS Simulator,name=$SIM_NAME`), Angular version check bypass (`NG_FORCE_NODE_VERSION_CHECK`), and web asset compilation (`npm run build` + `npx cap sync ios`).

---

## 3. Real iPhone Testing & Sideloading
* **Identified VPN / Cloudflare WARP Conflict**:
  * Sideloadly was throwing `404 Not Found` and `IPC fail: Timed out!` errors because Cloudflare WARP (VPN) was running on the PC, causing Apple's servers to block Apple ID authentication requests.
* **Signed and Installed with 3uTools**:
  * Temporarily paused Cloudflare WARP.
  * Used 3uTools IPA Signature tool to sign `App.ipa` using personal Apple ID (`monyvan455@gmail.com`).
  * Successfully transferred and installed **Doc Scanner** directly onto the physical iPhone 14.
  * Approved the developer certificate in iPhone **Settings → General → VPN & Device Management**.

---

## 4. How to Test Future Code Updates

### Option A: Real App Update on iPhone
1. Commit and push your code:
   ```bash
   git add .
   git commit -m "Your update description"
   git push
   ```
2. Wait for Codemagic to build and download the new `App.ipa`.
3. Open 3uTools → **Toolbox** → **IPA Signature** → Sign with your saved Apple ID.
4. Drag the newly signed IPA into 3uTools **Apps** to update the app on your phone.

### Option B: Instant Live Testing Over Wi-Fi (No Rebuild Needed)
For quick UI or logic changes without packaging an IPA:
1. Run in terminal:
   ```bash
   npx ionic serve --external
   ```
2. Open Safari on your iPhone (connected to the same Wi-Fi) and go to:
   ```text
   http://192.168.18.32:8100
   ```
3. Tap **Share → Add to Home Screen**. Any changes you save in your code editor will automatically refresh on your iPhone in real-time.

### Option C: Codemagic Quick Launch in Browser
1. Push your changes to GitHub.
2. Open the build overview in Codemagic.
3. Click the **Quick Launch** button next to the simulator `.app` artifact to test the app in an interactive cloud iPhone simulator.
