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

---

## 5. Web/Desktop UI & Empty State Fix
* **Issue**:
  * On desktop/web browsers, the empty state document placeholder was collapsed (0x0) because its styles were restricted to mobile media queries (`max-width: 860px`).
  * Text was squished side-by-side (`"No scanned pagesScan a document with your camera to start"`) due to default horizontal flex layout.
  * No action buttons existed on web to upload files or start a scan.
  * The top bar "Export PDF" button was text-clipped as `Export P...`.
* **Fix Applied**:
  * Configured `.empty-document-stage` with column layout, proper spacing, and centered alignment on web.
  * Added styled document placeholder illustration for desktop screens with subtle hover elevation.
  * Added desktop-specific action buttons ("Upload from computer" & "Scan with phone") using FieldBi signature pill styling, hidden automatically on mobile (`max-width: 860px`).
  * Added `white-space: nowrap; flex-shrink: 0;` to `.btn-export-pdf` to prevent text truncation in the desktop header.

---

## 6. Smart AI OCR & Computer Vision Edge Detection
* **Real AI Optical Character Recognition (OCR)**:
  * Integrated `tesseract.js` for on-device/client-side text recognition without external API fees or privacy exposure.
  * Added live progress visualizer showing initialization, language model loading, and real-time recognition percentage (0% to 100%).
  * Added live word count, character count metadata pills, and editable textarea.
  * Added instant "Copy Text" (with toast feedback) and "Export .TXT" plain text file download.
  * Included a quick "Re-scan" action to re-run OCR after applying contrast filters like "Clean B&W" or "Magic Pro".
* **Smart Auto Edge Detection**:
  * Implemented a Computer Vision algorithm using in-memory downsampled canvas, luminance mapping, and 3x3 Sobel gradient edge analysis.
  * Uses multi-ray casting from frame corners toward the center to automatically detect document borders and corner intersections against table/desk backgrounds.
  * Automatically detects paper edges upon image upload and updates the perspective crop quad instantly when clicking the "Auto Detect" button.

---

## 7. Multi-Format Export Center & IndexedDB Auto-Save History
* **Export Center (PDF, JPG, PNG & ZIP Archive)**:
  * Integrated `jszip` to generate and download all scanned pages compressed into a single `.zip` file archive.
  * Added instant single-page image export as high-resolution `.jpg` or `.png`.
  * Added PDF Quality presets: **HD (Print 300 DPI)** vs **Compressed (Email/Chat)** with live file size estimation.
* **Auto-Save & Recent Documents History (IndexedDB)**:
  * Integrated on-device `IndexedDB` (`FieldBiScannerDB`) to automatically persist active scan sessions with debounced auto-save.
  * Scans and page edits are never lost when refreshing the browser or restarting the mobile app.
  * Added interactive **Recent Documents** gallery in the left sidebar showing thumbnails, titles, page counts, relative timestamps, and one-click session switching.
  * Added inline document renaming directly from the stage top bar with animated `✓ Saved` indicator.
  * Added **+ New doc** button to start fresh scan sessions while keeping previous ones in history.

---

## 8. Custom In-App Confirmation Modal & UI Cleanup
* **Cleaned Up Mock Features**:
  * Removed the non-functional mock signature modal, buttons, and styles across HTML, SCSS, and TypeScript.
* **Replaced Native Browser `confirm()` & `alert()` Popups**:
  * Replaced the generic, unstyled browser `localhost:8100 says: Do you want to reset the current session?` popup with a custom in-app dialog matching FieldBi design guidelines.
  * Replaced native document deletion confirmation dialog with dedicated danger-themed modal (`Delete Document?`, trash icon, rose/danger accent button).
  * Replaced native ZIP export failure `alert()` with the in-app dialog.
* **Modern UI & UX Features**:
  * Frosted glass backdrop blur (`rgba(15, 23, 42, 0.5)` with `backdrop-filter: blur(8px)`).
  * Smooth entry micro-animation (`confirmScaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)`).
  * FieldBi brand pill buttons (`#ec1f28`), rounded icon badge, and top-right quick dismiss `X` button.
  * Dismissible by clicking the backdrop or tapping Cancel.

---

## 9. iOS UI Layout & Toolbar Collision Fixes
* **Resolved Empty State Toolbar & Button Overlap**:
  * Conditionally wrapped `.mobile-bottom-toolbar` with `@if (pages.length > 0)`.
  * In the zero-document state, editing actions (Crop, Rotate, B&W, Text) are hidden, eliminating the collision where the floating toolbar was covering the "Upload file" button.
* **Eliminated iOS Vertical Overflow & Safe Area Clipping**:
  * Removed negative `margin-top: calc(-1 * ...)` on `.cs-body` that was causing unnecessary page scrolling and pushing the bottom buttons off-screen.
  * Configured `.cs-window` with `overflow: hidden` and `.cs-body` with natural flex-1 scrolling.
  * Scaled the document illustration (`140px x 180px`) and reduced minimum canvas height to `200px` so the entire initial screen fits on any iPhone viewport (from iPhone SE to Pro Max) without vertical scrolling.
* **Modern iOS Floating Toolbar & Safe Area Insets**:
  * Updated `.mobile-bottom-toolbar` to float at `bottom: max(calc(env(safe-area-inset-bottom, 0px) + 12px), 20px)`.
  * Added frosted glass styling (`rgba(255, 255, 255, 0.96)` with `backdrop-filter: blur(20px)`), generous tap targets, and safe clearance from the iOS home indicator bar and rounded corner curves.
  * Added responsive button text labels (`Export PDF` on mobile, `Export Document` on desktop).
  * Synced updated web assets into native iOS project (`npx cap sync ios`).

---

## 10. Native iOS App Platform Enforcements
* **Native Platform vs. Responsive Breakpoints**:
  * Added Capacitor platform detection in TypeScript (`Capacitor.getPlatform() === 'ios' || Capacitor.isNativePlatform()`).
  * Bound `.ios-native-app` class to the main studio window.
  * Replaced screen-width-only constraints with an SCSS mixin (`@mixin ios-mobile-app-layout`) triggered by:
    1. Native iOS platform classes: `:host-context(.ios)`, `:host-context(.plt-ios)`, `:host-context(.plt-capacitor)`, and `.ios-native-app`.
    2. Mobile screen queries (`@media (max-width: 860px)`).
* **WKWebView Viewport Overflow Fix**:
  * Replaced `height: 100vh` and `width: 100vw` with `height: 100%`, `height: 100dvh`, and `height: -webkit-fill-available`.
  * Prevents iOS WKWebView from pushing the bottom elements 34px–44px below the physical screen.
* **Safe-Area Inset Support**:
  * Updated all header, body, action buttons, and toolbar offsets to consume `var(--ion-safe-area-top, env(safe-area-inset-top, 0px))` and `var(--ion-safe-area-bottom, env(safe-area-inset-bottom, 0px))`.
* **Codemagic Build Budget Resolution**:
  * Fixed `anyComponentStyle exceeded maximum budget 50kb` by removing duplicate SCSS mixin compilation and adjusting `angular.json` budget threshold.
  * Verified production build succeeds cleanly (`npm run build`).

---

## 11. Universal iPhone Architecture (Home Button, Notch & Dynamic Island)
* **Comprehensive Screen Compatibility**:
  * Works across all iPhone generations: iPhone SE (2nd/3rd gen) & iPhone 8 (375x667pt), iPhone 12/13 Mini (375x812pt), iPhone 11/12/13/14 (390x844pt), iPhone 14/15/16 Pro (Dynamic Island 393x852pt), and iPhone Plus / Pro Max (430x932pt - 440x956pt).
* **WKWebView Fixed Viewport & Bounce Prevention**:
  * Configured `html, body` with `position: fixed; width: 100%; height: 100dvh; overscroll-behavior-y: none;` in `global.scss`. Eliminates rubber-band bouncing of the outer WKWebView window while preserving smooth internal momentum scrolling.
  * Added `touch-action: manipulation; -webkit-tap-highlight-color: transparent;` to remove the 300ms iOS tap delay and tap highlights.
* **Status Bar Visibility Fix**:
  * Updated `StatusBar.setStyle({ style: Style.Dark })` in `app.component.ts` so time, battery, and Wi-Fi icons render dark/black against light header backgrounds on iOS.
* **Auto-Scaling Stage & Text Overflow Handling**:
  * Added `min-width: 0; text-overflow: ellipsis;` to document title input in the mobile header, ensuring it never collides with or wraps the `Export PDF` button on narrow 375px screens.
  * Constrained document canvas and paper images to `max-width: 100%; max-height: 100%; object-fit: contain;` inside `min-height: 0; overflow: hidden;` so tall documents scale to fit without pushing bottom navigation or action buttons off-screen.
  * Added `max-height: calc(100dvh - 36px); overflow-y: auto;` to `.modal-dialog` for smooth scrolling on small screens.

---

## 12. Bottom Dock & Thumbnail Overlap Elimination
* **Resolved Thumbnail Strip & Floating Toolbar Overlap**:
  * *Problem*: In previous iterations, `.mobile-bottom-toolbar` used `position: sticky; bottom: max(...)` independently from `.mobile-pages-strip`. On tall scanned documents, the sticky toolbar floated directly on top of the thumbnail strip, covering half of the `+ Scan` button and thumbnail cards.
  * *Fix*:
    1. Wrapped `.mobile-pages-strip` and `.mobile-bottom-toolbar` inside a unified container `<div class="mobile-bottom-dock">`.
    2. Changed `.mobile-bottom-toolbar` from `position: sticky` to `position: relative`, docking it below the thumbnail strip in natural flex flow.
    3. Added `margin-top: auto;` to `.mobile-bottom-dock` and set `.cs-body` to `overflow: hidden;` with `padding-bottom: 0`. This auto-scales the scanned document in the stage canvas while locking the bottom dock cleanly above the home indicator bar.
    4. Sized thumbnail cards (`52px × 66px`) and add button (`52px × 66px`) to compact, CamScanner-style dimensions with rounded corners and high-contrast green checkmark badge (`✓`).
* **Verified Across All iPhone Screen Sizes**:
  * Tested on iPhone SE (375 × 667), iPhone 12/13 Mini (375 × 812), iPhone 14/15/16 (393 × 852), and iPhone Pro Max (430 × 932). Both the thumbnail strip and bottom edit toolbar remain 100% visible with zero collision.
