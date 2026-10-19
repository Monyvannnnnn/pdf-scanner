# Project Context & AI Technical Reference Manual
**Project:** DocumentScannerApp (FieldBi Document Scanner / Scanly)  
**Package / App ID:** `com.fieldbi.documentscanner`  
**Target Platforms:** Web (Desktop & Mobile Safari/Chrome), iOS (Native via Capacitor), Android (Native via Capacitor)  
**Last Updated:** October 2026  

---

## 1. Executive Summary & Purpose

**DocumentScannerApp** is an enterprise-grade, privacy-first, on-device document scanning and image-processing studio built by FieldBi. It provides client-side scanning and document post-processing capabilities without relying on external cloud processing APIs, ensuring zero privacy exposure and zero recurring server costs.

### Core Capabilities:
- **Client-Side Document Ingestion**: Upload from local filesystem or live camera capture via HTML5 file input or native Capacitor camera integration.
- **Computer Vision Auto Edge Detection**: Automatic detection of document boundaries and corners against textured backgrounds using downsampled Sobel gradient analysis and ray-casting.
- **Interactive 4-Corner Perspective Cropping**: Homography perspective transformation engine with bilinear pixel interpolation and an interactive magnifying loupe.
- **Professional Image Processing Filters**: Signature CamScanner "Magic Pro" (local background illumination normalization with ink chroma preservation), Clean B&W, Enhance, Lighten, and No-Shadow filters.
- **Auto-Deskew & Fine Rotation**: Angle detection via projection profile variance analysis (-6° to +6°) alongside 90°/180° rotations and horizontal flipping.
- **On-Device Optical Character Recognition (OCR)**: Multi-lingual text extraction (`khm+eng` - Khmer + English permanent default) powered by `tesseract.js` running in web workers with PSM 6, real-time progress tracking, live change detection, and UTF-8 BOM `.txt` file export.
- **2-Step AP Invoice OCR-to-JSON & DB Insertion**:
  - **Step 1 (Extraction & Structuring)**: On-device extraction and pattern parsing of vendor headers, invoice numbers, dates, line items, subtotals, tax rates/amounts, and grand totals into structured `APInvoiceJSON`.
  - **FieldBi 3-Tab Glass Review Modal**:
    - **Tab 1 (AP Invoice JSON)**: Formatted JSON with copy-to-clipboard and `.json` file download.
    - **Tab 2 (AP Invoice Form)**: Editable form inputs, line items table CRUD, and real-time auto-recalculation.
    - **Tab 3 (Raw OCR Text)**: Inspect and edit raw OCR text with live sync back to form and JSON ("Update JSON from Text").
  - **Step 2 (Database Insertion)**: Direct client-to-cloud insertion into Supabase (`invoices` + `invoice_line_items` + Storage bucket `invoices` for PDF/image storage) with seamless fallback to local SQLite backend.
- **IndexedDB Auto-Save Session Management**: Offline persistence (`FieldBiScannerDB`) preserving active scans, pages, thumbnails, and custom document titles with debounced auto-save.
- **Multi-Format Export Center**:
  - **PDF Export (`pdf-lib`)**: Single or multi-page documents with A4, Letter, or Fit presets. Renders with **exact aspect ratio matching (zero white background margins)** and injects PDF catalog viewer preferences (`FitWindow`, `SinglePage`).
  - **Single Page Image Export**: High-resolution `.jpg` or `.png`.
  - **ZIP Archive Export (`jszip`)**: Batch downloads all processed pages into a compressed `.zip` archive.
- **Cross-Platform Responsive UX**: Desktop 3-floating-card studio layout adapting to native iOS/Android viewports with safe-area insets and floating frosted-glass toolbars.

---

## 2. Technology Stack & Key Dependencies

| Layer | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Framework** | Angular (Standalone Components) | `^22.1.7` | Reactive architecture, change detection, standalone component architecture |
| **Mobile Runtime** | Ionic Angular + Capacitor | `@ionic/angular: ^9.0.0`, `@capacitor/core: 8.5.3` | Cross-platform bridge for iOS, Android, and Web |
| **Database & Cloud** | Supabase JS Client | `@supabase/supabase-js: ^2.99.1`, `@supabase/ssr: ^0.9.0` | Cloud database persistence, storage uploads, and auth ready |
| **Multimodal Vision AI** | Google GenAI SDK | `@google/genai: ^2.30.0` | Gemini 2.5 Flash structured multilingual vision extraction |
| **Capacitor Plugins**| `@capacitor/status-bar`, `@capacitor/keyboard`, `@capacitor/haptics`, `@capacitor/app` | `^8.x` | Native platform hardware access and styling |
| **PDF Processing** | `pdf-lib` | `^1.17.1` | Programmatic PDF creation, image embedding, page layout, PDF catalog prefs |
| **OCR Engine** | `tesseract.js` | `^7.0.0` | Client-side Optical Character Recognition in Web Workers (Khmer & English `4.0.0_best`) |
| **Compression** | `jszip` | `^3.10.2` | In-memory ZIP packaging and batch download of scanned pages |
| **Image Engine** | Native HTML5 Canvas 2D API | Modern Web API | Homography matrix warping, Sobel edge filter, illumination leveling |
| **Storage Engine** | IndexedDB (`FieldBiScannerDB`) | Browser Native | On-device persistent storage for active documents and history |
| **Styling** | SCSS + CSS Variables + Glassmorphism | Custom | FieldBi design language (`#ec1f28` red accent, slate tones, frosted blur) |
| **Build & Tooling**| Angular CLI, Vite/Vitest, ESLint, Prettier | Angular `22.1.8`, TS `~6.0.0` | Production compilation and formatting |
| **CI / CD** | Codemagic | macOS M2 agents | Automated Android debug APKs and iOS IPA / Simulator builds |

---

## 3. Repository Architecture & Directory Structure

```text
DocumentScannerApp/
├── android/                         # Capacitor-generated native Android project
│   ├── app/                         # Android application module, manifests, and Gradle scripts
│   └── gradlew                      # Gradle wrapper executable (requires 100755 file mode)
├── ios/                             # Capacitor-generated native iOS project
│   └── App/                         # Xcode project (App.xcodeproj, Info.plist, Podfile)
├── server/                          # Optional backend microservices
│   ├── main.py                      # FastAPI + supabase-py backend service
│   ├── requirements.txt             # Python dependencies (supabase, fastapi, uvicorn, pydantic)
│   ├── server.js                    # Node.js + Express + SQLite fallback server
│   └── package.json                 # Express server configuration
├── src/
│   ├── app/
│   │   ├── app.component.ts         # Standalone root component (initializes Ionic providers)
│   │   ├── app.component.html       # <ion-app><ion-router-outlet></ion-router-outlet></ion-app>
│   │   ├── app.component.scss       # Global shell styling
│   │   ├── app.routes.ts            # Application routing (redirects '' to 'home')
│   │   ├── services/
│   │   │   ├── gemini-invoice.service.ts # Gemini 2.5 Flash Vision AI invoice extraction service
│   │   │   └── supabase.service.ts  # Supabase client service & InvoiceDatabaseService alias
│   │   └── home/
│   │       ├── home.page.ts         # CORE STUDIO COMPONENT: ~4,000 lines of image algorithms,
│   │       │                        # state management, Khmer/English OCR, storage, and export logic
│   │       ├── home.page.html       # Studio HTML template (Desktop 3-column & 3-Tab AP modal)
│   │       ├── home.page.scss       # Studio SCSS stylesheet with iOS platform mixins
│   │       └── home.page.spec.ts    # Unit test harness
│   ├── assets/                      # Static logos (FieldBi), icons, and sample assets
│   ├── environments/                # Environment configurations (environment.ts, prod.ts)
│   ├── global.scss                  # Global styles, fonts, and Ionic overrides
│   ├── index.html                   # HTML entry point with meta viewport & typography
│   └── main.ts                      # Angular standalone bootstrap with provideIonicAngular()
├── .env                             # Environment secrets (SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, etc.)
├── capacitor.config.ts              # Capacitor configuration (appId: com.fieldbi.documentscanner)
├── codemagic.yaml                   # Multi-workflow CI/CD pipelines (Android APK, iOS IPA, Simulator)
├── supabase_schema.sql              # Supabase DDL schema for invoices, invoice_line_items & RLS
└── package.json                     # Dependencies, scripts, and build triggers
```

---

## 4. Primary Data Models & Type Definitions

Located in [src/app/home/home.page.ts](file:///d:/FieldBi/pdf-scaner/DocumentScannerApp/src/app/home/home.page.ts):

### 4.1 Document Studio Models
```typescript
// Supported document image filters
export type FilterType = 'original' | 'enhance' | 'magic' | 'lighten' | 'noShadow' | 'bw';

// Document layout settings
export type PageOrientation = 'portrait' | 'landscape';
export type PageSizeOption = 'a4' | 'fit' | 'letter';

// 2D percentage coordinates (0 to 100)
export interface Point2D {
  x: number; // 0..100
  y: number; // 0..100
}

// 4-corner perspective cropping quad
export interface QuadCorners {
  tl: Point2D; // Top-Left
  tr: Point2D; // Top-Right
  br: Point2D; // Bottom-Right
  bl: Point2D; // Bottom-Left
}

// Single scanned page data structure
export interface CamScannerPage {
  id: string;
  originalDataUrl: string;   // Clean uncropped, unrotated source image
  croppedDataUrl: string;    // Image after 4-corner perspective crop
  displayDataUrl: string;    // Image after crop + rotation + straighten + filter
  fileName?: string;
  filter: FilterType;        // Active filter applied
  rotation: number;          // Coarse rotation (0, 90, 180, 270 deg)
  straightenAngle: number;   // Fine skew adjustment (-25 to +25 deg)
  flipH: boolean;            // Horizontal flip state
  cropQuad: QuadCorners;     // Corner quad in percentage
  naturalWidth: number;
  naturalHeight: number;
}
```

### 4.2 Comprehensive AP Invoice Schema
```typescript
export interface APInvoiceAddress {
  name?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  taxId?: string; // VAT / TIN number
}

export interface APInvoiceLineItem {
  itemNo: number;
  itemCode?: string; // SKU or Item #
  description: string;
  quantity: number;
  unitOfMeasure?: string; // pcs, hours, kg, etc.
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  total: number;
}

export interface APInvoiceJSON {
  documentType: 'AP_INVOICE';
  currency: string;
  vendor: APInvoiceAddress;
  billTo: APInvoiceAddress;
  shipTo?: APInvoiceAddress;
  invoiceNumber: string;
  invoiceDate: string;    // YYYY-MM-DD
  dueDate?: string;        // YYYY-MM-DD
  poNumber?: string;
  paymentTerms?: string;
  items: APInvoiceLineItem[];
  subtotal: number;
  taxRate?: number;
  taxAmount: number;
  grandTotal: number;
  balanceDue?: number;
  notes?: string;
  termsAndConditions?: string;
  rawOcrText: string;
  vendorName?: string;     // Compatibility flat binding
  billedTo?: string;       // Compatibility flat binding
}
```

---

## 5. Core Architectural Modules & Algorithms

### 5.1 Interactive 4-Corner Homography Perspective Warping
- **Implementation**: `extractPerspectiveCrop(dataUrl, quad)` & `getPerspectiveTransformMatrix(srcQuad, dstW, dstH)`.
- **Fast Path**: If the user's quad is rectangular within a 0.6% threshold tolerance, it executes an instant sub-rectangle crop using `ctx.drawImage()`.
- **Angled Perspective Warp**:
  1. Computes destination canvas dimensions (`dstW`, `dstH`) using Euclidean distances between top/bottom and left/right corners.
  2. Solves the 8-parameter 3x3 Homography Matrix mapping the destination bounding box back to the arbitrary quadrilateral in source coordinates.
  3. Maps pixels via inverse mapping with **bilinear interpolation** (`w00, w10, w01, w11`), avoiding pixelation artifacts.
  4. Bounds max warp dimension to `2048px` to guarantee ultra-fast CPU processing while preserving 300 DPI print clarity.

### 5.2 Magnifying Loupe / Zoom Bubble
- During interactive corner drag in crop mode, a floating circular loupe tracks the user's finger or cursor (`loupePos`), rendering a 350% magnified view of the underlying document pixels with a crosshair for millimeter-exact corner placement.

### 5.3 Computer Vision Auto Edge Detection
- **Implementation**: `detectDocumentCorners(dataUrl)`.
- **Pipeline**:
  1. Downsamples image to width `320px` for < 20ms real-time execution.
  2. Generates grayscale luminance map using standard Rec. 601 coefficients:  
     $$\text{Lum} = 0.299R + 0.587G + 0.114B$$
  3. Samples background luminance reference from the outer 5% margin.
  4. Computes 3x3 Sobel gradient convolution magnitude ($G_x$ and $G_y$).
  5. Casts 5 multi-ratio rays from each corner toward the center, finding points where gradient magnitude and background luminance difference exceed adaptive thresholds (`gVal > edgeThresh && lumDiff > contrastDelta`).
  6. Filters and clamps detected corners to ensure a valid convex quadrilateral.

### 5.4 Signature CamScanner "Magic Pro" Filter
- **Implementation**: `applyMagicPro(d, width, height)`.
- **Algorithm**:
  - Divides image into adaptive blocks (16px–36px) and estimates local background paper illumination.
  - Applies 2D box blur (`blurGrid`) and bilinear interpolation (`bilerp`) across the illumination grid to produce a smooth lighting map.
  - Normalizes pixel luminance by dividing local RGB by the estimated background.
  - **Chroma Preservation**: Detects colored handwriting/stamps:
    - Blue ink: `b > r + 15 && b > g + 5 && chroma > 18`
    - Red ink: `r > g + 35 && r > b + 35 && chroma > 30`
    - Preserves and enhances ink vibrancy while driving yellowish or shaded paper backgrounds to pure crisp white (`#ffffff`).

### 5.5 Auto-Deskew Angle Detection
- **Implementation**: `detectSkewAngle(dataUrl)`.
- Analyzes projection profile variance between -6° and +6° at 0.25° increments. The rotation angle that maximizes row-sum luminance variance corresponds to perfectly horizontal text baselines.

### 5.6 Real In-Browser OCR & Table Alignment
- **Implementation**: `runOcr()` with `tesseract.js`.
- **Language Models**: Uses Naptha `4.0.0_best` language models permanently defaulted to `khm+eng` (Khmer + English).
- **Page Segmentation**: Configured with `tessedit_pageseg_mode: '6'` (Single uniform block of text) and `preserve_interword_spaces: '1'` so invoice line item columns stay aligned on the same row.
- **NgZone & Reactive Change Detection**: Wrapped inside Angular's `NgZone.run()` + `ChangeDetectorRef.detectChanges()` to prevent Web Worker execution stalls where the UI previously required mouse movement to update.

### 5.7 Smart Bilingual Text-to-JSON Parser
- **Implementation**: `parseFullApInvoice(rawText)` in [home.page.ts](file:///d:/FieldBi/pdf-scaner/DocumentScannerApp/src/app/home/home.page.ts).
- **Unicode & Numeral Normalization**:
  - NFC normalization and zero-width space removal (`\u200B`).
  - Converts Khmer numerals (`[០-៩]`) to standard Arabic digits (`[0-9]`) for reliable numeric matching.
- **Rule-Based Vendor Extraction (`extractVendorName`)**:
  - Scans top 5 document lines.
  - Filters out invoice header keywords (`INVOICE`, `Bill To`, `វិក្កយបត្រ`).
  - Filters street addresses (`Street`, `Road`, `Avenue`, `PO Box`, `Suite`) and street numbers.
  - Rejects single/double-letter OCR noise fragments (e.g. `"i Le 4"`).
  - Cleans trailing punctuation and noise artifacts.
- **Header & Financial Field Extraction**:
  - English & Khmer keywords: `invoiceNumber` (`INV-000001`, `លេខវិក្កយបត្រ`), `poNumber` (`លេខបញ្ជាទិញ`), `invoiceDate` & `dueDate` (`កាលបរិច្ឆេទ`, `ថ្ងៃផុតកំណត់`), `paymentTerms` (`លក្ខខណ្ឌ`), `subtotal` (`សរុបរង`), `taxAmount` (`ពន្ធ`), `grandTotal` (`សរុបរួម`), `balanceDue` (`ទឹកប្រាក់ត្រូវបង់`).
  - **Local Calendar Formatting**: `standardizeDateString()` preserves local calendar day/month/year components to prevent UTC timezone day-shifts (e.g., Aug 5 shifting to Aug 4 in GMT+0700).
- **Dual Table Order Matching**:
  - Format 1: `Description | Qty | Unit Price | Total`
  - Format 2: `Description | Unit Price | Qty | Total`
  - Supports decimal quantities (`1.00`) and arbitrary currency symbols (`$`, `៛`).

### 5.8 Supabase Cloud Database & Storage Integration
- **Implementation**: [src/app/services/supabase.service.ts](file:///d:/FieldBi/pdf-scaner/DocumentScannerApp/src/app/services/supabase.service.ts).
- **Relational Schema**:
  - `public.invoices`: Master invoice record (`vendor_name`, `invoice_number`, `issue_date`, `currency`, `subtotal`, `tax_amount`, `grand_total`, `raw_text`, `pdf_url`).
  - `public.invoice_line_items`: Segmented line items linked via `invoice_id references invoices(id) on delete cascade`.
- **Storage Upload**: Automatically uploads processed document image/PDF to Supabase Storage bucket `invoices`, generating a public `pdf_url` attached to the invoice record.
- **Fallback Architecture**: Gracefully falls back to legacy `ap_invoices` table (`PGRST205` / `42P01`) or local backend server if Supabase tables are pending creation.
- **Service Alias**: Exports `InvoiceDatabaseService` as an alias for direct dependency injection.

---

## 6. Supabase Database Schema ([supabase_schema.sql](file:///d:/FieldBi/pdf-scaner/DocumentScannerApp/supabase_schema.sql))

```sql
-- 1. Invoices Table
create table if not exists public.invoices (
    id uuid default gen_random_uuid() primary key,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    vendor_name text,
    invoice_number text,
    issue_date date,
    currency text,
    subtotal numeric(12, 2),
    tax_amount numeric(12, 2),
    grand_total numeric(12, 2),
    raw_text text,
    pdf_url text
);

-- 2. Line Items Table (Linked to Invoices)
create table if not exists public.invoice_line_items (
    id uuid default gen_random_uuid() primary key,
    invoice_id uuid references public.invoices(id) on delete cascade not null,
    description text,
    quantity numeric(10, 2),
    unit_price numeric(12, 2),
    total numeric(12, 2)
);

-- Indexes for optimal lookup speed
create index if not exists idx_invoices_invoice_number on public.invoices(invoice_number);
create index if not exists idx_invoices_vendor_name on public.invoices(vendor_name);
create index if not exists idx_invoices_issue_date on public.invoices(issue_date);
create index if not exists idx_invoice_line_items_invoice_id on public.invoice_line_items(invoice_id);

-- Enable Row Level Security (RLS)
alter table public.invoices enable row level security;
alter table public.invoice_line_items enable row level security;

-- Row Level Security Policies
create policy "Allow anon read invoices" on public.invoices for select using (true);
create policy "Allow anon insert invoices" on public.invoices for insert with check (true);
create policy "Allow anon update invoices" on public.invoices for update using (true) with check (true);
create policy "Allow anon delete invoices" on public.invoices for delete using (true);

create policy "Allow anon read invoice_line_items" on public.invoice_line_items for select using (true);
create policy "Allow anon insert invoice_line_items" on public.invoice_line_items for insert with check (true);
create policy "Allow anon update invoice_line_items" on public.invoice_line_items for update using (true) with check (true);
create policy "Allow anon delete invoice_line_items" on public.invoice_line_items for delete using (true);
```

---

## 7. Important Rules & Guardrails for AI & Future Developers

When modifying or extending this codebase, adhere to the following strict guidelines:

1. **Angular Zone & Change Detection with Web Workers**:
   - Any background worker callback (e.g. `Tesseract.js` progress or completion) MUST be wrapped in `this.ngZone.run(() => { ... this.cdr.detectChanges(); })`. Never rely on mouse movement or browser events to trigger template re-renders.
2. **Local Calendar Formatting for Dates**:
   - Never use `date.toISOString().split('T')[0]` on user dates in timezones ahead of UTC (e.g. GMT+0700). Always use `standardizeDateString()` using local calendar components (`getFullYear()`, `getMonth() + 1`, `getDate()`) to prevent day-shift bugs.
3. **Aspect Ratio Preservation in Export**:
   - Never force documents into distorted dimensions. Always calculate either width-based or height-based scaling matching the image's natural aspect ratio.
4. **Prevent White Background Padding in PDFs**:
   - Do NOT center images inside standard A4 canvas with giant white borders. Page dimensions must equal scaled image dimensions.
5. **Safe-Area Insets on iOS**:
   - Never set fixed `bottom: 0px` for mobile toolbars. Always use `max(calc(env(safe-area-inset-bottom, 0px) + 12px), 20px)` to avoid collision with the iOS home indicator bar.
6. **Performance & V-Sync in Interactive Canvas**:
   - Any corner-drag or pointer movement MUST use `requestAnimationFrame` throttling (`animFrameId`) to avoid triggering Angular change-detection bottlenecks at 120Hz.
7. **No Native `window.confirm()` or `alert()`**:
   - Always route user confirmations through `this.openConfirmation(...)` to maintain UI immersion and FieldBi brand standards.
8. **Sync Web Code After Changes**:
   - Whenever modifying TypeScript, HTML, or SCSS and intending to test on native devices, run:
     ```bash
     npm run build
     npx cap sync
     ```
