import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent } from '@ionic/angular';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import JSZip from 'jszip';
import { Capacitor } from '@capacitor/core';
import { SupabaseService } from '../services/supabase.service';
import { GeminiInvoiceService } from '../services/gemini-invoice.service';

export type FilterType =
  'original' | 'enhance' | 'magic' | 'lighten' | 'noShadow' | 'bw';

export type PageOrientation = 'portrait' | 'landscape';
export type PageSizeOption = 'a4' | 'fit' | 'letter';

export interface Point2D {
  x: number; // percentage 0..100
  y: number; // percentage 0..100
}

export interface QuadCorners {
  tl: Point2D;
  tr: Point2D;
  br: Point2D;
  bl: Point2D;
}

export interface CamScannerPage {
  id: string;
  originalDataUrl: string;
  croppedDataUrl: string;
  displayDataUrl: string;
  fileName?: string;
  filter: FilterType;
  rotation: number; // 0, 90, 180, 270
  straightenAngle: number; // fine rotation -25..+25 deg
  flipH: boolean;
  cropQuad: QuadCorners; // 4 perspective corners
  naturalWidth: number;
  naturalHeight: number;
}

export interface SavedDocumentSession {
  id: string;
  fileName: string;
  pages: CamScannerPage[];
  pageOrientation: PageOrientation;
  pageSize: PageSizeOption;
  activePageIndex: number;
  updatedAt: number;
  thumbnail: string;
}

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

  // 1. Vendor (Supplier) Info
  vendor: APInvoiceAddress;

  // 2. Customer / Bill-To & Ship-To Info
  billTo: APInvoiceAddress;
  shipTo?: APInvoiceAddress;

  // 3. Invoice Header Details
  invoiceNumber: string;
  invoiceDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  poNumber?: string; // Purchase Order # (P.O.#)
  paymentTerms?: string; // e.g., "Net 30", "Due on Receipt"

  // 4. Line Items Table
  items: APInvoiceLineItem[];

  // 5. Financial Summary / Totals
  subtotal: number;
  discountTotal?: number;
  shippingCost?: number;
  taxRate?: number;
  taxAmount: number;
  grandTotal: number;
  balanceDue?: number;

  // 6. Footer & Payment Instructions
  bankDetails?: {
    bankName?: string;
    accountName?: string;
    accountNumber?: string;
    swiftOrRouting?: string;
  };
  notes?: string;
  termsAndConditions?: string;
  rawOcrText?: string;

  // Legacy flat fields for template bindings
  vendorName?: string;
  billedTo?: string;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, FormsModule],
})
export class HomePage implements OnInit, OnDestroy {
  @ViewChild('cropOverlayRef') cropOverlayRef?: ElementRef<HTMLDivElement>;
  @ViewChild('fileInputRef') fileInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('cameraInputRef') cameraInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('paperImageRef') paperImageRef?: ElementRef<HTMLImageElement>;
  @ViewChild('cropImageRef') cropImageRef?: ElementRef<HTMLImageElement>;

  // Platform Detection
  isIosApp = Capacitor.getPlatform() === 'ios' || Capacitor.isNativePlatform();

  // Header Scroll Blur State
  isScrolled = false;

  // Pages State
  pages: CamScannerPage[] = [];
  activePageIndex = 0;
  applyToAllPages = true;

  // Page Orientation & Size Setup
  pageOrientation: PageOrientation = 'portrait';
  pageSize: PageSizeOption = 'a4';

  // Interactive 4-Corner Perspective Cropping State
  isCropMode = false;
  activeCropHandle: string | null = null;
  cropDragStart = { x: 0, y: 0 };
  cropQuadSnapshot: QuadCorners = {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 100, y: 100 },
    bl: { x: 0, y: 100 },
  };

  // Loupe / Magnifying Glass State
  showLoupe = false;
  loupePos = { x: 0, y: 0 };
  loupeBgPos = '50% 50%';
  loupeBgSize = '350%';
  loupeBgUrl = '';

  // Performance & Drag Throttling State
  private animFrameId: number | null = null;
  private pendingPointerEvent: PointerEvent | null = null;

  // Rotation & Straighten UI State
  showRotateOptions = false;
  showStraightenPanel = false;

  // Export / Multi-Format Export Center State
  showExportModal = false;
  generatedPdfUrl: string | null = null;
  pdfFileName = '';
  pdfFileSize = '';
  isProcessing = false;
  processingMessage = 'Processing document...';
  exportFormat: 'pdf' | 'images' = 'pdf';
  exportQuality: 'high' | 'compressed' = 'high';
  isZipExporting = false;
  zipProgress = 0;

  // Scans & Document State (IndexedDB Persistent Storage)
  activeDocId = 'doc_' + Date.now();
  activeDocFileName = 'Document.pdf';
  showSaveIndicator = false;
  private saveTimeout: any = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  recentDocs: Array<{
    id: string;
    title: string;
    fileName: string;
    pagesCount: number;
    time: string;
    updatedAt: number;
    thumbnail: string;
  }> = [];

  // Custom Confirmation Dialog State
  showConfirmDialog = false;
  confirmDialogTitle = '';
  confirmDialogMessage = '';
  confirmDialogType: 'warning' | 'delete' | 'reset' | 'success' = 'reset';
  confirmDialogActionText = 'Confirm';
  confirmDialogCancelText = 'Cancel';
  private confirmActionCallback: (() => void) | null = null;

  // Real OCR & Signature Modal States
  showOcrModal = false;
  ocrExtractedText = '';
  isOcrRunning = false;
  ocrProgress = 0;
  ocrStatusText = 'Initializing OCR engine...';
  ocrCopied = false;
  ocrWordCount = 0;
  ocrCharCount = 0;
  ocrError: string | null = null;
  ocrLastProcessedPageId = '';
  ocrLanguage = 'khm+eng';
  private ocrWorkerInstance: any = null;
  private ocrWorkerCurrentLang = '';

  // --- AP Invoice Extraction State ---
  isExtractingApInvoice = false;
  showApInvoiceModal = false;
  activeApTab: 'json' | 'form' | 'raw' = 'json';
  extractedApInvoice: any = null;
  isSubmittingApInvoice = false;

  // Compatibility accessors for template & internal bindings
  get isExtractingInvoice(): boolean {
    return this.isExtractingApInvoice;
  }
  set isExtractingInvoice(val: boolean) {
    this.isExtractingApInvoice = val;
  }

  get showInvoiceJsonModal(): boolean {
    return this.showApInvoiceModal;
  }
  set showInvoiceJsonModal(val: boolean) {
    this.showApInvoiceModal = val;
  }

  get activeInvoiceTab(): 'json' | 'form' | 'raw' {
    return this.activeApTab;
  }
  set activeInvoiceTab(val: 'json' | 'form' | 'raw') {
    this.activeApTab = val;
  }

  get extractedInvoiceJson(): any {
    return this.extractedApInvoice;
  }
  set extractedInvoiceJson(val: any) {
    this.extractedApInvoice = val;
  }

  get currentApInvoice(): any {
    return this.extractedApInvoice;
  }
  set currentApInvoice(val: any) {
    this.extractedApInvoice = val;
  }

  get isApModalOpen(): boolean {
    return this.showApInvoiceModal;
  }
  set isApModalOpen(val: boolean) {
    this.showApInvoiceModal = val;
  }

  copiedInvoiceJson = false;
  backendApiUrl = 'http://localhost:3000/api/ap-invoices';

  // Scan with Phone QR Modal State
  showQrModal = false;
  peerId = 'fb-7K3-92X';
  inputPeerId = '';
  isPeerConnected = false;
  copiedPeerId = false;

  // Mobile Device Connection & Bottom Sheet State (Screenshots 1, 2, 3)
  connectedDeviceName = 'MacBook';
  showSendToComputerSheet = false;

  get activePage(): CamScannerPage | undefined {
    return this.pages[this.activePageIndex];
  }

  // --- SVG Path & Coordinate Helpers for 4-Corner Quad ---
  get cropQuadSvgPoints(): string {
    if (!this.activePage) return '';
    const q = this.activePage.cropQuad;
    return `${q.tl.x},${q.tl.y} ${q.tr.x},${q.tr.y} ${q.br.x},${q.br.y} ${q.bl.x},${q.bl.y}`;
  }

  get cropQuadMaskPath(): string {
    if (!this.activePage) return '';
    const q = this.activePage.cropQuad;
    return `M 0 0 L 100 0 L 100 100 L 0 100 Z M ${q.tl.x} ${q.tl.y} L ${q.tr.x} ${q.tr.y} L ${q.br.x} ${q.br.y} L ${q.bl.x} ${q.bl.y} Z`;
  }

  get edgeMidpoints() {
    if (!this.activePage) {
      return {
        t: { x: 50, y: 0 },
        r: { x: 100, y: 50 },
        b: { x: 50, y: 100 },
        l: { x: 0, y: 50 },
      };
    }
    const q = this.activePage.cropQuad;
    return {
      t: { x: (q.tl.x + q.tr.x) / 2, y: (q.tl.y + q.tr.y) / 2 },
      r: { x: (q.tr.x + q.br.x) / 2, y: (q.tr.y + q.br.y) / 2 },
      b: { x: (q.bl.x + q.br.x) / 2, y: (q.bl.y + q.br.y) / 2 },
      l: { x: (q.tl.x + q.bl.x) / 2, y: (q.tl.y + q.bl.y) / 2 },
    };
  }

  get gridLineCoords() {
    if (!this.activePage) return null;
    const q = this.activePage.cropQuad;
    const t1 = {
      x: q.tl.x + (q.tr.x - q.tl.x) / 3,
      y: q.tl.y + (q.tr.y - q.tl.y) / 3,
    };
    const t2 = {
      x: q.tl.x + ((q.tr.x - q.tl.x) * 2) / 3,
      y: q.tl.y + ((q.tr.y - q.tl.y) * 2) / 3,
    };

    const b1 = {
      x: q.bl.x + (q.br.x - q.bl.x) / 3,
      y: q.bl.y + (q.br.y - q.bl.y) / 3,
    };
    const b2 = {
      x: q.bl.x + ((q.br.x - q.bl.x) * 2) / 3,
      y: q.bl.y + ((q.br.y - q.bl.y) * 2) / 3,
    };

    const l1 = {
      x: q.tl.x + (q.bl.x - q.tl.x) / 3,
      y: q.tl.y + (q.bl.y - q.tl.y) / 3,
    };
    const l2 = {
      x: q.tl.x + ((q.bl.x - q.tl.x) * 2) / 3,
      y: q.tl.y + ((q.bl.y - q.tl.y) * 2) / 3,
    };

    const r1 = {
      x: q.tr.x + (q.br.x - q.tr.x) / 3,
      y: q.tr.y + (q.br.y - q.tr.y) / 3,
    };
    const r2 = {
      x: q.tr.x + ((q.br.x - q.tr.x) * 2) / 3,
      y: q.tr.y + ((q.br.y - q.tr.y) * 2) / 3,
    };

    return { t1, t2, b1, b2, l1, l2, r1, r2 };
  }

  constructor(
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    public geminiInvoiceService: GeminiInvoiceService,
    public supabaseService: SupabaseService,
  ) {}

  async ngOnInit() {
    // Listen to all scroll events anywhere in the viewport (including ion-content and body)
    window.addEventListener(
      'scroll',
      (e: Event) => {
        const target = e.target as HTMLElement | Document;
        let top = 0;
        if (target === document || target === document.documentElement) {
          top = window.scrollY || document.documentElement.scrollTop || 0;
        } else if (target && 'scrollTop' in target) {
          top = (target as HTMLElement).scrollTop;
        }
        this.isScrolled = top > 2;
      },
      true,
    );

    // Initialize IndexedDB storage and restore previous sessions
    await this.initStorageAndRestore();
  }

  @HostListener('window:scroll', [])
  onWindowScroll() {
    const scrollY =
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    this.isScrolled = scrollY > 2;
  }

  onIonScroll(event: any) {
    const top = event?.detail?.scrollTop ?? 0;
    this.isScrolled = top > 2;
  }

  onBodyScroll(event: Event) {
    const target = event.target as HTMLElement;
    if (target) {
      this.isScrolled = target.scrollTop > 2;
    }
  }

  async loadDefaultSample() {
    // Clean start: No default image loaded, ready for user's own scan or upload
    this.pages = [];
    this.activePageIndex = 0;
  }

  // --- Add Page from Image DataURL ---
  private async addPageFromDataUrl(
    dataUrl: string,
    isSample = false,
    replace = false,
    fileName?: string,
  ) {
    const { width, height } = await this.getImageDimensions(dataUrl);

    // Initial 4-corner perspective quad
    // Auto-detect corners with computer vision for uploaded images; use preset for sample receipt
    const quad: QuadCorners = isSample
      ? {
          tl: { x: 4.1, y: 2.8 },
          tr: { x: 97.0, y: 1.2 },
          br: { x: 96.8, y: 96.5 },
          bl: { x: 6.8, y: 97.8 },
        }
      : await this.detectDocumentCorners(dataUrl);

    const pageId = isSample
      ? 'sample_receipt'
      : `page_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Keep image as original default on upload (no auto-crop, no magic filter)
    const croppedUrl = isSample
      ? await this.extractPerspectiveCrop(dataUrl, quad)
      : dataUrl;

    const displayUrl = isSample
      ? await this.renderProcessedImage(croppedUrl, 0, 0, false, 'magic')
      : dataUrl;

    const newPage: CamScannerPage = {
      id: pageId,
      fileName,
      originalDataUrl: dataUrl,
      croppedDataUrl: croppedUrl,
      displayDataUrl: displayUrl,
      filter: 'original',
      rotation: 0,
      straightenAngle: 0,
      flipH: false,
      cropQuad: quad,
      naturalWidth: width,
      naturalHeight: height,
    };

    if (
      replace ||
      (this.pages.length === 1 && this.pages[0].id === 'sample_receipt')
    ) {
      this.pages = [newPage];
      this.activePageIndex = 0;
    } else {
      this.pages.push(newPage);
      this.activePageIndex = this.pages.length - 1;
    }
    this.isCropMode = false;
    this.queueAutoSave();
  }

  // --- Pointer Drag Listeners for Interactive 4-Corner Cropping ---
  @HostListener('window:pointermove', ['$event'])
  onPointerMove(event: PointerEvent) {
    if (!this.isCropMode || !this.activeCropHandle || !this.activePage) return;
    this.pendingPointerEvent = event;

    // Throttle to 60fps v-sync with requestAnimationFrame to prevent change-detection chokes
    if (this.animFrameId === null) {
      this.animFrameId = requestAnimationFrame(() => {
        this.processPointerMove();
        this.animFrameId = null;
      });
    }
  }

  private processPointerMove() {
    const event = this.pendingPointerEvent;
    if (
      !event ||
      !this.isCropMode ||
      !this.activeCropHandle ||
      !this.activePage
    )
      return;
    const overlay = this.cropOverlayRef?.nativeElement;
    if (!overlay) return;

    const rect = overlay.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const currentPercentX = ((event.clientX - rect.left) / rect.width) * 100;
    const currentPercentY = ((event.clientY - rect.top) / rect.height) * 100;

    const dx = currentPercentX - this.cropDragStart.x;
    const dy = currentPercentY - this.cropDragStart.y;
    const snap = this.cropQuadSnapshot;
    const q = this.activePage.cropQuad;
    const clamp = (val: number) => Math.max(0, Math.min(100, val));

    switch (this.activeCropHandle) {
      case 'tl':
        q.tl.x = clamp(snap.tl.x + dx);
        q.tl.y = clamp(snap.tl.y + dy);
        this.updateLoupe(q.tl.x, q.tl.y);
        break;
      case 'tr':
        q.tr.x = clamp(snap.tr.x + dx);
        q.tr.y = clamp(snap.tr.y + dy);
        this.updateLoupe(q.tr.x, q.tr.y);
        break;
      case 'br':
        q.br.x = clamp(snap.br.x + dx);
        q.br.y = clamp(snap.br.y + dy);
        this.updateLoupe(q.br.x, q.br.y);
        break;
      case 'bl':
        q.bl.x = clamp(snap.bl.x + dx);
        q.bl.y = clamp(snap.bl.y + dy);
        this.updateLoupe(q.bl.x, q.bl.y);
        break;
      case 't':
        q.tl.y = clamp(snap.tl.y + dy);
        q.tr.y = clamp(snap.tr.y + dy);
        this.updateLoupe((q.tl.x + q.tr.x) / 2, (q.tl.y + q.tr.y) / 2);
        break;
      case 'b':
        q.bl.y = clamp(snap.bl.y + dy);
        q.br.y = clamp(snap.br.y + dy);
        this.updateLoupe((q.bl.x + q.br.x) / 2, (q.bl.y + q.br.y) / 2);
        break;
      case 'l':
        q.tl.x = clamp(snap.tl.x + dx);
        q.bl.x = clamp(snap.bl.x + dx);
        this.updateLoupe((q.tl.x + q.bl.x) / 2, (q.tl.y + q.bl.y) / 2);
        break;
      case 'r':
        q.tr.x = clamp(snap.tr.x + dx);
        q.br.x = clamp(snap.br.x + dx);
        this.updateLoupe((q.tr.x + q.br.x) / 2, (q.tr.y + q.br.y) / 2);
        break;
      case 'body':
        const minX = Math.min(snap.tl.x, snap.bl.x);
        const maxX = Math.max(snap.tr.x, snap.br.x);
        const minY = Math.min(snap.tl.y, snap.tr.y);
        const maxY = Math.max(snap.bl.y, snap.br.y);

        const safeDx = Math.max(-minX, Math.min(100 - maxX, dx));
        const safeDy = Math.max(-minY, Math.min(100 - maxY, dy));

        q.tl.x = snap.tl.x + safeDx;
        q.tl.y = snap.tl.y + safeDy;
        q.tr.x = snap.tr.x + safeDx;
        q.tr.y = snap.tr.y + safeDy;
        q.br.x = snap.br.x + safeDx;
        q.br.y = snap.br.y + safeDy;
        q.bl.x = snap.bl.x + safeDx;
        q.bl.y = snap.bl.y + safeDy;
        break;
    }
  }

  @HostListener('window:pointerup')
  onPointerUp() {
    this.activeCropHandle = null;
    this.showLoupe = false;
    this.pendingPointerEvent = null;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  startCropDrag(handle: string, event: PointerEvent) {
    if (!this.activePage) return;
    event.preventDefault();
    event.stopPropagation();
    this.activeCropHandle = handle;

    const overlay = this.cropOverlayRef?.nativeElement;
    if (overlay) {
      const rect = overlay.getBoundingClientRect();
      this.cropDragStart = {
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
      };
      this.cropQuadSnapshot = {
        tl: { ...this.activePage.cropQuad.tl },
        tr: { ...this.activePage.cropQuad.tr },
        br: { ...this.activePage.cropQuad.br },
        bl: { ...this.activePage.cropQuad.bl },
      };

      if (handle !== 'body') {
        this.loupeBgUrl = this.activePage
          ? `url(${this.activePage.originalDataUrl})`
          : '';
        this.updateLoupe(this.cropDragStart.x, this.cropDragStart.y);
      }
    }
  }

  private updateLoupe(targetPercentX: number, targetPercentY: number) {
    this.showLoupe = true;
    const offsetY = targetPercentY < 24 ? 20 : -20;
    const offsetX = targetPercentX > 80 ? -16 : targetPercentX < 20 ? 16 : 0;

    this.loupePos = {
      x: Math.max(8, Math.min(92, targetPercentX + offsetX)),
      y: Math.max(8, Math.min(92, targetPercentY + offsetY)),
    };
    this.loupeBgPos = `${targetPercentX}% ${targetPercentY}%`;
    this.loupeBgSize = '350%';
  }

  promptUploadFirst(featureName: string) {
    this.openConfirmation(
      'No Document Page',
      `Please upload or scan an image first to use ${featureName}.`,
      'Upload Image',
      () => {
        this.triggerUpload();
      },
      'warning',
      'Cancel',
    );
  }

  toggleCropMode() {
    if (!this.activePage) {
      this.promptUploadFirst('Crop & Straighten');
      return;
    }
    this.isCropMode = !this.isCropMode;
    if (this.isCropMode) {
      this.showRotateOptions = false;
      this.showStraightenPanel = false;
      this.loupeBgUrl = `url(${this.activePage.originalDataUrl})`;
    }
  }

  toggleRotateOptions() {
    if (!this.activePage) {
      this.promptUploadFirst('Rotate & Straighten');
      return;
    }
    this.showRotateOptions = !this.showRotateOptions;
    if (this.showRotateOptions) {
      this.isCropMode = false;
    }
  }

  toggleStraightenPanel() {
    if (!this.activePage) {
      this.promptUploadFirst('Fine Angle Straighten');
      return;
    }
    this.showStraightenPanel = !this.showStraightenPanel;
    if (this.showStraightenPanel) {
      this.isCropMode = false;
    }
  }

  // --- Crop Action Buttons ---
  async applyCrop() {
    const page = this.activePage;
    if (!page) return;
    this.isProcessing = true;
    this.processingMessage = 'Applying perspective crop...';
    // Yield to let UI render the processing indicator
    await new Promise((r) => setTimeout(r, 16));

    try {
      page.croppedDataUrl = await this.extractPerspectiveCrop(
        page.originalDataUrl,
        page.cropQuad,
      );

      // Fast-path: Skip canvas re-rendering if filter is original and no rotation/straighten
      if (
        page.filter === 'original' &&
        page.rotation === 0 &&
        page.straightenAngle === 0 &&
        !page.flipH
      ) {
        page.displayDataUrl = page.croppedDataUrl;
      } else {
        page.displayDataUrl = await this.renderProcessedImage(
          page.croppedDataUrl,
          page.rotation,
          page.straightenAngle,
          page.flipH,
          page.filter,
        );
      }
      this.isCropMode = false;
      this.queueAutoSave();
    } finally {
      this.isProcessing = false;
    }
  }

  async resetCrop() {
    const page = this.activePage;
    if (!page) return;
    this.isProcessing = true;
    this.processingMessage = 'Resetting crop...';
    await new Promise((r) => setTimeout(r, 16));

    try {
      if (page.id === 'sample_receipt') {
        page.cropQuad = {
          tl: { x: 4.1, y: 2.8 },
          tr: { x: 97.0, y: 1.2 },
          br: { x: 96.8, y: 96.5 },
          bl: { x: 6.8, y: 97.8 },
        };
      } else {
        page.cropQuad = {
          tl: { x: 0, y: 0 },
          tr: { x: 100, y: 0 },
          br: { x: 100, y: 100 },
          bl: { x: 0, y: 100 },
        };
      }
      page.straightenAngle = 0;
      page.croppedDataUrl = page.originalDataUrl;
      if (
        page.filter === 'original' &&
        page.rotation === 0 &&
        page.straightenAngle === 0 &&
        !page.flipH
      ) {
        page.displayDataUrl = page.originalDataUrl;
      } else {
        page.displayDataUrl = await this.renderProcessedImage(
          page.originalDataUrl,
          page.rotation,
          page.straightenAngle,
          page.flipH,
          page.filter,
        );
      }
      this.isCropMode = false;
      this.queueAutoSave();
    } finally {
      this.isProcessing = false;
    }
  }

  // --- Smart Computer Vision Edge Detection ---
  async autoDetectCrop() {
    const page = this.activePage;
    if (!page) return;
    this.isProcessing = true;
    this.processingMessage = 'Detecting document borders...';
    await new Promise((r) => setTimeout(r, 16));

    try {
      if (page.id === 'sample_receipt') {
        page.cropQuad = {
          tl: { x: 4.1, y: 2.8 },
          tr: { x: 97.0, y: 1.2 },
          br: { x: 96.8, y: 96.5 },
          bl: { x: 6.8, y: 97.8 },
        };
      } else {
        const detected = await this.detectDocumentCorners(page.originalDataUrl);
        page.cropQuad = detected;
      }
    } catch (err) {
      console.warn('Auto edge detection fallback:', err);
      page.cropQuad = {
        tl: { x: 3, y: 3 },
        tr: { x: 97, y: 3 },
        br: { x: 97, y: 97 },
        bl: { x: 3, y: 97 },
      };
    } finally {
      this.isProcessing = false;
    }
  }

  makeCropStraight() {
    const page = this.activePage;
    if (!page) return;
    const q = page.cropQuad;
    // Align top edge horizontally
    const avgTopY = (q.tl.y + q.tr.y) / 2;
    q.tl.y = avgTopY;
    q.tr.y = avgTopY;

    // Align bottom edge horizontally
    const avgBotY = (q.bl.y + q.br.y) / 2;
    q.bl.y = avgBotY;
    q.br.y = avgBotY;

    // Align left edge vertically
    const avgLeftX = (q.tl.x + q.bl.x) / 2;
    q.tl.x = avgLeftX;
    q.bl.x = avgLeftX;

    // Align right edge vertically
    const avgRightX = (q.tr.x + q.br.x) / 2;
    q.tr.x = avgRightX;
    q.br.x = avgRightX;
  }

  // --- Rotations & Straightening ---
  async rotateLeft() {
    await this.applyRotation(-90);
  }

  async rotateRight() {
    await this.applyRotation(90);
  }

  async rotate180() {
    await this.applyRotation(180);
  }

  async rotateInCrop(delta = 90) {
    const page = this.activePage;
    if (!page) return;

    try {
      const domImg = this.cropImageRef?.nativeElement;
      const rotatedUrl = await this.fastRotateImageDataUrl(
        page.originalDataUrl,
        delta,
        domImg,
      );
      page.originalDataUrl = rotatedUrl;
      page.croppedDataUrl = rotatedUrl;
      page.displayDataUrl = rotatedUrl;
      const tmp = page.naturalWidth;
      page.naturalWidth = page.naturalHeight;
      page.naturalHeight = tmp;

      // Rotate crop quad corners clockwise
      const q = page.cropQuad;
      if (delta === 90) {
        const oldTl = { ...q.tl };
        const oldTr = { ...q.tr };
        const oldBr = { ...q.br };
        const oldBl = { ...q.bl };

        q.tr = { x: 100 - oldTl.y, y: oldTl.x };
        q.br = { x: 100 - oldTr.y, y: oldTr.x };
        q.bl = { x: 100 - oldBr.y, y: oldBr.x };
        q.tl = { x: 100 - oldBl.y, y: oldBl.x };
      }
      this.loupeBgUrl = `url(${page.originalDataUrl})`;
    } catch (e) {
      console.warn('Fast crop rotation failed:', e);
    }
  }

  // --- High Performance Instant Rotation & Flip Helpers ---
  private fastRotateImageDataUrl(
    dataUrl: string,
    delta: number,
    preferredImg?: HTMLImageElement,
  ): Promise<string> {
    return new Promise((resolve) => {
      const domImg =
        preferredImg ||
        (this.paperImageRef?.nativeElement &&
        dataUrl === this.activePage?.displayDataUrl
          ? this.paperImageRef.nativeElement
          : undefined);

      if (domImg && domImg.complete && domImg.naturalWidth > 0) {
        resolve(this.drawRotatedCanvas(domImg, delta));
        return;
      }

      const img = new Image();
      img.onload = () => resolve(this.drawRotatedCanvas(img, delta));
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  private drawRotatedCanvas(img: HTMLImageElement, delta: number): string {
    const is90or270 = Math.abs(delta % 180) === 90;
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = is90or270 ? nh : nw;
    canvas.height = is90or270 ? nw : nh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return img.src;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((delta * Math.PI) / 180);
    ctx.drawImage(img, -nw / 2, -nh / 2);

    return canvas.toDataURL('image/jpeg', 0.88);
  }

  private fastFlipImageDataUrl(
    dataUrl: string,
    preferredImg?: HTMLImageElement,
  ): Promise<string> {
    return new Promise((resolve) => {
      const domImg =
        preferredImg ||
        (this.paperImageRef?.nativeElement &&
        dataUrl === this.activePage?.displayDataUrl
          ? this.paperImageRef.nativeElement
          : undefined);

      if (domImg && domImg.complete && domImg.naturalWidth > 0) {
        resolve(this.drawFlippedCanvas(domImg));
        return;
      }

      const img = new Image();
      img.onload = () => resolve(this.drawFlippedCanvas(img));
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  private drawFlippedCanvas(img: HTMLImageElement): string {
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    const canvas = document.createElement('canvas');
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return img.src;

    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0);

    return canvas.toDataURL('image/jpeg', 0.88);
  }

  async flipHorizontal() {
    if (!this.activePage) return;
    const targets = this.applyToAllPages ? this.pages : [this.activePage];
    for (const p of targets) {
      p.flipH = !p.flipH;
      const domImg =
        p.id === this.activePage.id
          ? this.paperImageRef?.nativeElement
          : undefined;
      const flipped = await this.fastFlipImageDataUrl(p.displayDataUrl, domImg);
      p.displayDataUrl = flipped;
      if (p.croppedDataUrl && p.croppedDataUrl !== p.displayDataUrl) {
        p.croppedDataUrl = await this.fastFlipImageDataUrl(p.croppedDataUrl);
      } else {
        p.croppedDataUrl = flipped;
      }
    }
    this.queueAutoSave();
  }

  private async applyRotation(delta: number) {
    if (!this.activePage) return;
    const targets = this.applyToAllPages ? this.pages : [this.activePage];
    const isSwap = Math.abs(delta % 180) === 90;

    for (const p of targets) {
      p.rotation = (p.rotation + delta + 360) % 360;

      const domImg =
        p.id === this.activePage.id
          ? this.paperImageRef?.nativeElement
          : undefined;
      const rotatedDisplay = await this.fastRotateImageDataUrl(
        p.displayDataUrl,
        delta,
        domImg,
      );
      p.displayDataUrl = rotatedDisplay;

      if (p.croppedDataUrl && p.croppedDataUrl !== p.displayDataUrl) {
        p.croppedDataUrl = await this.fastRotateImageDataUrl(
          p.croppedDataUrl,
          delta,
        );
      } else {
        p.croppedDataUrl = rotatedDisplay;
      }

      if (isSwap) {
        const tmp = p.naturalWidth;
        p.naturalWidth = p.naturalHeight;
        p.naturalHeight = tmp;
      }
    }

    // Instantly adapt pageOrientation card sheet to document's new aspect ratio
    if (this.activePage) {
      this.pageOrientation =
        this.activePage.naturalWidth > this.activePage.naturalHeight
          ? 'landscape'
          : 'portrait';
    }

    this.queueAutoSave();
  }

  // --- Fine Straighten Controls ---
  async setStraightenAngle(angle: number) {
    if (!this.activePage) return;
    const clamped = Math.max(-25, Math.min(25, Math.round(angle * 10) / 10));
    const targets = this.applyToAllPages ? this.pages : [this.activePage];
    for (const p of targets) {
      p.straightenAngle = clamped;
      p.displayDataUrl = await this.renderProcessedImage(
        p.croppedDataUrl,
        p.rotation,
        p.straightenAngle,
        p.flipH,
        p.filter,
      );
      if (p.id === this.activePage.id && this.paperImageRef?.nativeElement) {
        this.paperImageRef.nativeElement.src = p.displayDataUrl;
        this.paperImageRef.nativeElement.style.transform = '';
      }
    }
    this.cdr.detectChanges();
    this.queueAutoSave();
  }

  async adjustStraightenAngle(delta: number) {
    if (!this.activePage) return;
    await this.setStraightenAngle(this.activePage.straightenAngle + delta);
  }

  onStraightenSliderInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    if (isNaN(val) || !this.activePage) return;

    this.activePage.straightenAngle = val;
    // Real-time CSS transform so slider drag gives buttery-smooth 60fps instant rotation while mouse is held
    if (this.paperImageRef?.nativeElement) {
      this.paperImageRef.nativeElement.style.transform = `rotate(${val}deg)`;
    }
    this.cdr.detectChanges();
  }

  async onStraightenSliderChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    if (!isNaN(val)) {
      if (this.paperImageRef?.nativeElement) {
        this.paperImageRef.nativeElement.style.transform = '';
      }
      await this.setStraightenAngle(val);
    }
  }

  async autoDeskew() {
    if (!this.activePage) return;
    this.isProcessing = true;
    try {
      // Analyze current cropped image for horizontal table/line tilt
      const detectedAngle = await this.detectSkewAngle(
        this.activePage.croppedDataUrl,
      );
      await this.setStraightenAngle(detectedAngle);
    } finally {
      this.isProcessing = false;
      this.cdr.detectChanges();
    }
  }

  // --- Filter Selection ---
  async setFilter(filter: FilterType) {
    if (!this.activePage) return;

    this.activePage.filter = filter;
    this.cdr.detectChanges(); // Immediately reflect active button highlight

    if (this.applyToAllPages) {
      for (const p of this.pages) {
        p.filter = filter;
        p.displayDataUrl = await this.renderProcessedImage(
          p.croppedDataUrl,
          p.rotation,
          p.straightenAngle,
          p.flipH,
          p.filter,
        );
        if (p.id === this.activePage.id && this.paperImageRef?.nativeElement) {
          this.paperImageRef.nativeElement.src = p.displayDataUrl;
        }
      }
    } else {
      this.activePage.displayDataUrl = await this.renderProcessedImage(
        this.activePage.croppedDataUrl,
        this.activePage.rotation,
        this.activePage.straightenAngle,
        this.activePage.flipH,
        this.activePage.filter,
      );
      if (this.paperImageRef?.nativeElement) {
        this.paperImageRef.nativeElement.src = this.activePage.displayDataUrl;
      }
    }
    this.cdr.detectChanges(); // Immediately flush change detection without waiting for mouseleave/mousemove
    this.queueAutoSave();
  }

  toggleApplyToAll() {
    this.applyToAllPages = !this.applyToAllPages;
  }

  // --- Page Navigation & Upload ---
  selectPage(index: number) {
    this.activePageIndex = index;
    this.isCropMode = false;
  }

  triggerUpload() {
    this.fileInputRef?.nativeElement?.click();
  }

  async onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;

    this.isProcessing = true;
    this.processingMessage = 'Loading & optimizing scan...';
    // Yield to let UI render the processing indicator immediately
    await new Promise((r) => setTimeout(r, 16));

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) {
          if (
            i === 0 &&
            (!this.pages.length || this.activeDocFileName === 'Document.pdf')
          ) {
            const baseName = file.name.replace(/\.[^/.]+$/, '');
            this.activeDocFileName = `${baseName}.pdf`;
          }
          const optimizedDataUrl = await this.optimizeUploadedImage(file);
          await this.addPageFromDataUrl(
            optimizedDataUrl,
            false,
            false,
            file.name,
          );
        }
      }
    } catch (err) {
      console.error('Failed to load image files:', err);
    } finally {
      this.isProcessing = false;
      input.value = '';
    }
  }

  handleBack() {
    if (this.isCropMode) {
      this.isCropMode = false;
      return;
    }
    if (this.showRotateOptions) {
      this.showRotateOptions = false;
      return;
    }
    if (this.showStraightenPanel) {
      this.showStraightenPanel = false;
      return;
    }
    this.closeModal();
  }

  // --- Custom Confirmation Dialog Methods ---
  openConfirmation(
    title: string,
    message: string,
    actionText = 'OK',
    onConfirm: () => void = () => {},
    type: 'warning' | 'delete' | 'reset' | 'success' = 'reset',
    cancelText = 'Cancel',
  ) {
    this.confirmDialogTitle = title;
    this.confirmDialogMessage = message;
    this.confirmDialogActionText = actionText;
    this.confirmDialogCancelText = cancelText;
    this.confirmDialogType = type;
    this.confirmActionCallback = onConfirm;
    this.showConfirmDialog = true;
  }

  onConfirmAccept() {
    this.showConfirmDialog = false;
    if (this.confirmActionCallback) {
      const cb = this.confirmActionCallback;
      this.confirmActionCallback = null;
      cb();
    }
  }

  onConfirmCancel() {
    this.showConfirmDialog = false;
    this.confirmActionCallback = null;
  }

  closeModal() {
    this.openConfirmation(
      'Reset Current Session?',
      'Do you want to reset the current session? Any unsaved pages will be cleared and a new blank document will start.',
      'Reset Session',
      () => {
        this.createNewDocument();
      },
      'reset',
      'Cancel',
    );
  }

  selectRecentDoc(doc: {
    id: string;
    title: string;
    fileName: string;
    pagesCount: number;
  }) {
    this.switchOrRestoreDocument(doc.id);
  }

  toggleFilterBw() {
    if (!this.activePage) {
      this.promptUploadFirst('Clean B&W Filter');
      return;
    }
    const nextFilter: FilterType =
      this.activePage.filter === 'bw' ? 'original' : 'bw';
    this.setFilter(nextFilter);
  }

  // --- Real Tesseract.js OCR Methods ---
  async openOcrModal() {
    if (!this.activePage) {
      this.promptUploadFirst('Text Recognition (AI OCR)');
      return;
    }
    this.ngZone.run(() => {
      this.activeInvoiceTab = 'raw';
      this.showInvoiceJsonModal = true;
      this.showApInvoiceModal = true;
      this.showOcrModal = false;
      this.ocrCopied = false;
      this.ocrError = null;
      this.cdr.detectChanges();
    });

    // Automatically trigger OCR if new page or not yet processed
    if (
      this.ocrLastProcessedPageId !== this.activePage.id ||
      !this.ocrExtractedText
    ) {
      await this.runOcr();
    } else {
      this.ngZone.run(() => {
        this.updateOcrCounts();
        this.cdr.detectChanges();
      });
    }
  }

  async changeOcrLanguage(lang: string) {
    if (this.ocrLanguage === lang || this.isOcrRunning) return;
    this.ocrLanguage = lang;
    this.ocrLastProcessedPageId = '';
    this.cdr.detectChanges();
    await this.runOcr();
  }

  async runOcr() {
    const page = this.activePage;
    if (!page) return;

    this.ngZone.run(() => {
      this.isOcrRunning = true;
      this.isExtractingApInvoice = true;
      this.ocrProgress = 0;
      const langLabel =
        this.ocrLanguage === 'khm+eng'
          ? 'Khmer & English'
          : this.ocrLanguage === 'khm'
            ? 'Khmer'
            : 'English';
      this.ocrStatusText = `Initializing OCR engine (${langLabel})...`;
      this.ocrError = null;
      this.cdr.detectChanges();
    });

    try {
      // Pass the clean image from the active page viewer directly to Tesseract
      // (no destructive high-contrast binarization that turns wood grain/shadows into lines)
      const cleanImage =
        page.displayDataUrl || page.croppedDataUrl || page.originalDataUrl;

      // Re-use or instantiate worker; tear down when language changes
      if (
        !this.ocrWorkerInstance ||
        this.ocrWorkerCurrentLang !== this.ocrLanguage
      ) {
        if (this.ocrWorkerInstance) {
          try {
            await this.ocrWorkerInstance.terminate();
          } catch (_) {}
          this.ocrWorkerInstance = null;
        }

        const langs =
          this.ocrLanguage === 'khm+eng'
            ? ['khm', 'eng']
            : this.ocrLanguage.includes('+')
              ? this.ocrLanguage.split('+')
              : [this.ocrLanguage];

        const langLabel =
          this.ocrLanguage === 'khm+eng'
            ? 'Khmer & English'
            : this.ocrLanguage === 'khm'
              ? 'Khmer'
              : 'English';

        this.ocrWorkerInstance = await createWorker(langs, 1, {
          langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
          logger: (m: any) => {
            this.ngZone.run(() => {
              if (m.status === 'recognizing text') {
                this.ocrProgress = Math.min(
                  100,
                  Math.round((m.progress || 0) * 100),
                );
                this.ocrStatusText = `Recognizing text (${this.ocrProgress}%)...`;
              } else if (m.status === 'loading tesseract core') {
                this.ocrStatusText = 'Loading OCR Core...';
              } else if (m.status === 'loading language traineddata') {
                const pct = Math.round((m.progress || 0) * 100);
                this.ocrProgress = Math.min(99, pct);
                this.ocrStatusText =
                  pct > 0
                    ? `Downloading ${langLabel} model... ${pct}%`
                    : `Downloading ${langLabel} model...`;
              } else if (m.status === 'initializing api') {
                this.ocrStatusText = 'Preparing recognition engine...';
              } else if (m.status === 'initialized api') {
                this.ocrProgress = 0;
                this.ocrStatusText = 'Starting text recognition...';
              }
              this.cdr.detectChanges();
            });
          },
        });

        // Use PSM 6 (Single uniform block of text) and preserve_interword_spaces
        // so Khmer + English invoice table rows stay cleanly aligned on the same line
        await this.ocrWorkerInstance.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        });

        this.ocrWorkerCurrentLang = this.ocrLanguage;
      }

      this.ngZone.run(() => {
        this.ocrStatusText = 'Analyzing document & aligning tables...';
        this.cdr.detectChanges();
      });

      const ret = await this.ocrWorkerInstance.recognize(cleanImage);

      this.ngZone.run(() => {
        // Filter out garbage lines and background texture artifacts
        const filtered = this.filterOcrLines(ret.data);
        this.ocrExtractedText =
          filtered ||
          ret.data?.text ||
          'No readable text was detected on this page. Try adjusting lighting or re-taking the photo with higher contrast.';
        this.ocrLastProcessedPageId = page.id;
        this.updateOcrCounts();
        if (this.ocrExtractedText) {
          const parsed = this.parseFullApInvoice(this.ocrExtractedText);
          this.extractedInvoiceJson = parsed;
          this.extractedApInvoice = parsed;
        }
        this.isOcrRunning = false;
        this.isExtractingApInvoice = false;
        this.cdr.detectChanges();
      });
    } catch (err: any) {
      console.error('OCR Error:', err);
      try {
        if (this.ocrWorkerInstance) await this.ocrWorkerInstance.terminate();
      } catch (_) {}
      this.ocrWorkerInstance = null;
      this.ocrWorkerCurrentLang = '';
      this.ngZone.run(() => {
        this.ocrError =
          'Unable to recognize text. Please check your internet connection for language model downloading, or try switching language.';
        this.isOcrRunning = false;
        this.isExtractingApInvoice = false;
        this.cdr.detectChanges();
      });
    } finally {
      this.ngZone.run(() => {
        this.isOcrRunning = false;
        this.isExtractingApInvoice = false;
        this.cdr.detectChanges();
      });
    }
  }

  /**
   * Filter out garbage lines and background noise:
   * 1. Average word confidence on that line below threshold (35 for Khmer, 55 for English)
   * 2. More than 40% of the characters are symbols/slashes (/, \, #, %, =, ), (, ;, §)
   */
  private filterOcrLines(data: any): string {
    const SYMBOL_PATTERN = /[\/\\#%=\)\(;§]/g;
    const rawLines = data?.lines || [];
    const isKhmer = (this.ocrLanguage || '').includes('khm');

    if (!rawLines.length) {
      const textLines = (data?.text || '').split('\n');
      return textLines
        .filter((line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          const nonSpaceChars = trimmed.replace(/\s/g, '').length;
          if (nonSpaceChars === 0) return false;
          const symbolMatches = trimmed.match(SYMBOL_PATTERN) || [];
          return symbolMatches.length / nonSpaceChars <= 0.40;
        })
        .join('\n')
        .trim();
    }

    const filteredLines: string[] = [];

    for (const line of rawLines) {
      const lineText = (line.text || '').trim();
      if (!lineText) continue;

      // 1. Average word confidence check
      // For Khmer scripts with complex ligatures/subscripts, Tesseract reports lower confidence
      // (35-50), so we use a more forgiving threshold of 35 when Khmer is involved.
      const hasKhmerChars = /[\u1780-\u17FF]/.test(lineText);
      const minConfidence = isKhmer || hasKhmerChars ? 35 : 55;

      let avgConfidence = 0;
      if (line.words && line.words.length > 0) {
        const sum = line.words.reduce(
          (acc: number, w: any) =>
            acc + (typeof w.confidence === 'number' ? w.confidence : 0),
          0,
        );
        avgConfidence = sum / line.words.length;
      } else if (typeof line.confidence === 'number') {
        avgConfidence = line.confidence;
      } else {
        avgConfidence = 100;
      }

      if (avgConfidence < minConfidence) {
        continue;
      }

      // 2. Symbol/slash density check: drop if > 40% of characters are symbols/slashes
      const nonSpaceChars = lineText.replace(/\s/g, '').length;
      if (nonSpaceChars === 0) continue;

      const symbolMatches = lineText.match(SYMBOL_PATTERN) || [];
      const symbolRatio = symbolMatches.length / nonSpaceChars;
      if (symbolRatio > 0.40) {
        continue;
      }

      // 3. Drop lines that are purely horizontal dividers, underlines, or isolated noise letters (e.g. "_   ត  យ")
      const lettersAndDigits = lineText.replace(/[^A-Za-z0-9\u1780-\u17FF]/g, '');
      if (lettersAndDigits.length < 3 && /^[_\-.:~*+=|#\s]+/.test(lineText)) {
        continue;
      }

      filteredLines.push(lineText);
    }

    return filteredLines.join('\n').trim();
  }

  async ngOnDestroy() {
    if (this.ocrWorkerInstance) {
      try {
        await this.ocrWorkerInstance.terminate();
      } catch (_) {}
      this.ocrWorkerInstance = null;
    }
  }

  closeOcrModal() {
    this.showOcrModal = false;
    this.showInvoiceJsonModal = false;
  }

  onOcrTextInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    this.ocrExtractedText = target.value;
    this.updateOcrCounts();
  }

  updateOcrCounts() {
    const text = (this.ocrExtractedText || '').trim();
    this.ocrCharCount = text.length;
    this.ocrWordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  }

  async copyOcrText() {
    if (!this.ocrExtractedText) return;
    try {
      await navigator.clipboard.writeText(this.ocrExtractedText);
      this.ocrCopied = true;
      setTimeout(() => {
        this.ocrCopied = false;
      }, 2500);
    } catch (e) {
      const el = document.createElement('textarea');
      el.value = this.ocrExtractedText;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      this.ocrCopied = true;
      setTimeout(() => {
        this.ocrCopied = false;
      }, 2500);
    }
  }

  exportOcrTxt() {
    if (!this.ocrExtractedText) return;
    // Prepend UTF-8 BOM (\uFEFF) so Windows Notepad / Excel detect UTF-8 and render
    // Khmer script correctly without garbling the characters.
    const bom = '\uFEFF';
    const blob = new Blob([bom + this.ocrExtractedText], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const baseName = this.activeDocFileName.replace(/\.pdf$/i, '');
    a.href = url;
    a.download = `${baseName}_Page_${this.activePageIndex + 1}_Text.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // --- AP Invoice Extraction & Processing Methods (Khmer + English) ---
  // =========================================================================

  /**
   * Converts Khmer numerals (០-៩) to Latin standard digits (0-9)
   */
  convertKhmerNumerals(text: string): string {
    if (!text) return '';
    const khmerDigits = ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩'];
    return text.replace(/[០-៩]/g, (ch) => {
      const idx = khmerDigits.indexOf(ch);
      return idx !== -1 ? String(idx) : ch;
    });
  }

  /**
   * Normalizes Khmer Unicode (NFC) for consistent regex matching and character rendering
   */
  private normalizeKhmerText(text: string): string {
    if (!text) return '';
    return text.normalize('NFC');
  }

  /**
   * Run Gemini 2.5 Flash Multimodal Vision Extraction on active processed document canvas
   */
  async runGeminiAiExtraction(
    activePageDataUrl: string,
    preserveActiveTab = false
  ): Promise<APInvoiceJSON | null> {
    try {
      const currentTab = this.activeApTab;
      this.ngZone.run(() => {
        this.isExtractingApInvoice = true;
        this.isOcrRunning = true;
        this.ocrProgress = 20;
        this.ocrStatusText = 'Analyzing document with Gemini Vision AI...';
        this.showInvoiceJsonModal = true;
        this.showApInvoiceModal = true;
        if (!preserveActiveTab) {
          this.activeInvoiceTab = 'json';
          this.activeApTab = 'json';
        }
        this.cdr.detectChanges();
      });

      // 1. Send active processed page canvas snapshot directly to Gemini Vision
      const extractedInvoiceJson =
        await this.geminiInvoiceService.extractInvoiceFromImageOrPdf(activePageDataUrl);

      // 2. Update UI state inside NgZone to trigger the 3-Tab Glass Review Modal
      this.ngZone.run(() => {
        this.currentApInvoice = extractedInvoiceJson;
        this.extractedApInvoice = extractedInvoiceJson;
        this.extractedInvoiceJson = extractedInvoiceJson;
        this.ocrExtractedText = extractedInvoiceJson.rawOcrText || '';
        this.updateOcrCounts();
        this.ocrProgress = 100;
        this.ocrStatusText = 'Gemini Vision Extraction Complete';
        this.isExtractingApInvoice = false;
        this.isOcrRunning = false;
        this.isApModalOpen = true; // Opens your FieldBi 3-Tab Glass Review Modal
        this.showInvoiceJsonModal = true;
        if (preserveActiveTab) {
          this.activeApTab = currentTab;
          this.activeInvoiceTab = currentTab;
        }
        this.cdr.detectChanges();
      });

      return extractedInvoiceJson;
    } catch (error) {
      console.error('Gemini AI Extraction failed:', error);
      this.ngZone.run(() => {
        this.ocrStatusText = 'Gemini offline or error, falling back to on-device OCR...';
        this.cdr.detectChanges();
      });
      return null;
    }
  }

  /**
   * Triggered when user clicks "Extract AP Invoice" or "Recognize text"
   */
  async extractAndConvertApInvoice(preserveActiveTab = false): Promise<void> {
    const activePage = this.pages[this.activePageIndex];
    if (!activePage || !activePage.displayDataUrl) {
      console.warn('No active page found to extract.');
      this.promptUploadFirst('Extract AP Invoice');
      return;
    }

    const cleanImage =
      activePage.displayDataUrl || activePage.croppedDataUrl || activePage.originalDataUrl;

    // 1. First attempt high-speed multimodal vision extraction with Gemini 2.5 Flash
    if (this.geminiInvoiceService) {
      const geminiResult = await this.runGeminiAiExtraction(cleanImage, preserveActiveTab);
      if (geminiResult) {
        return;
      }
    }

    // 2. Fallback to on-device Tesseract OCR engine with PSM 6 table alignment
    this.ngZone.run(() => {
      if (!preserveActiveTab) {
        this.activeInvoiceTab = 'json';
        this.activeApTab = 'json';
      }
      this.showInvoiceJsonModal = true;
      this.showApInvoiceModal = true;
      this.cdr.detectChanges();
    });

    await this.runOcr();
  }

  /**
   * Alias method for existing template bindings
   */
  async extractApInvoiceToJson(): Promise<void> {
    await this.extractAndConvertApInvoice();
  }

  /**
   * Re-parses manually edited raw OCR text back into structured AP Invoice JSON
   */
  reParseOcrTextToJson(): void {
    if (!this.ocrExtractedText) return;
    this.ngZone.run(() => {
      const parsed = this.parseFullApInvoice(this.ocrExtractedText);
      this.extractedApInvoice = parsed;
      this.extractedInvoiceJson = parsed;
      this.currentApInvoice = parsed;
      this.activeApTab = 'form';
      this.activeInvoiceTab = 'form';
      this.cdr.detectChanges();
    });
  }

  /**
   * Method 1: The Smart Rule-Based Approach (Best for Tesseract OCR)
   * Extracts vendor name from the top lines, filtering keywords, addresses, and noise artifacts.
   */
  private extractVendorName(lines: string[]): string {
    // Usually, the vendor name is within the first 8 lines of the invoice
    const topLines = lines.slice(0, 8);

    // Words to ignore if they appear at the top
    const ignoreWords = ['invoice', 'bill to', 'ship to', 'logo', 'date', 'phone', 'វិក្កយបត្រ', 'tax', 'receipt', 'tel', 'fax', 'po box'];

    for (const line of topLines) {
      // Strip leading and trailing non-alphanumeric / non-Khmer characters (e.g. _, -, ., :, |, #, etc.)
      const clean = line.replace(/^[_\s\-.:|#~*+=]+/, '').replace(/[_\s\-.:|#~*+=]+$/, '').replace(/\s+/g, ' ').trim();
      if (!clean) continue;

      const lower = clean.toLowerCase();
      const isIgnored = ignoreWords.some((w) => lower.includes(w));
      if (isIgnored) continue;

      // Filter street numbers and address lines
      if (
        /\b(street|st\b|road|rd\b|avenue|ave\b|boulevard|blvd\b|lane|drive|dr\b|po box|floor|suite|building|new york|u\.?s\.?a)\b/i.test(
          clean,
        )
      ) {
        continue;
      }
      if (/^\d+([A-Za-z]?)[,\s]/.test(clean)) continue;

      // Must have at least 3 letters/Khmer characters in total
      const lettersOnly = clean.replace(/[^A-Za-z\u1780-\u17FF]/g, '');
      if (lettersOnly.length < 3) continue;

      // Filter out fragmented single-character noise artifacts (e.g. "_   ត  យ")
      const words = clean.split(' ').filter((w) => /[A-Za-z\u1780-\u17FF]/.test(w));
      const hasSubstantialWord = words.some(
        (w) => w.replace(/[^A-Za-z\u1780-\u17FF]/g, '').length >= 3,
      );
      if (!hasSubstantialWord) continue;

      return clean.replace(/[\s,.-]+(oo)?\.?$/i, '').trim();
    }

    return 'Unknown Vendor';
  }

  /**
   * Upgraded Parser to Extract All Fields supporting both English and Khmer keywords
   */
  private parseFullApInvoice(rawText: string): APInvoiceJSON {
    const cleanedText = rawText.normalize('NFC').replace(/\u200B/g, '');
    const lines = cleanedText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // Normalize Khmer numerals to standard Arabic digits for reliable numerical matching
    const convertedDigitsText = this.convertKhmerNumerals ? this.convertKhmerNumerals(cleanedText) : cleanedText;

    // Header Regex Extractors (English & Khmer)
    const invMatch =
      cleanedText.match(/(?:invoice\s*(?:no|number|#)|invoice\s*[:៖#]|inv\s*(?:no|#|[:៖])|bill\s*#|ref\s*#|លេខវិក្កយបត្រ|វិក្កយបត្រលេខ)\s*[:៖.#-]?\s*([A-Za-z0-9-]+)/i) ||
      convertedDigitsText.match(/(?:invoice\s*(?:no|number|#)?|លេខវិក្កយបត្រ)\s*[:៖.#-]?\s*([A-Za-z0-9-]+)/i);

    const poMatch =
      cleanedText.match(/(?:\b(?:p\.?o\.?\s*(?:no|#)?|po\s*number|purchase\s*order)\b|លេខបញ្ជាទិញ)\s*[:៖.#-]?\s*([A-Za-z0-9-]+)/i) ||
      convertedDigitsText.match(/(?:\b(?:p\.?o\.?\s*(?:no|#)?)\b|លេខបញ្ជាទិញ)\s*[:៖.#-]?\s*([A-Za-z0-9-]+)/i);

    const dateMatch =
      cleanedText.match(/(?:invoice\s*date|issue\s*date|dated|កាលបរិច្ឆេទ|ថ្ងៃទី)\s*[:៖.-]?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4}|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i) ||
      cleanedText.match(/(?:date|issued)\s*[:៖.-]?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4}|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i) ||
      convertedDigitsText.match(/(?:invoice\s*date|date|កាលបរិច្ឆេទ)\s*[:៖.-]?\s*(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i);

    const dueMatch =
      cleanedText.match(/(?:due\s*date|payment\s*due|ថ្ងៃផុតកំណត់)\s*[:៖.-]?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4}|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i) ||
      cleanedText.match(/(?:due)\s*[:៖.-]?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4}|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i) ||
      convertedDigitsText.match(/(?:due\s*date|ថ្ងៃផុតកំណត់)\s*[:៖.-]?\s*(\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})/i);

    const termsMatch =
      cleanedText.match(/(?:terms|payment\s*terms|លក្ខខណ្ឌ|លក្ខខណ្ឌទូទាត់)\s*[:៖.-]?\s*([^\n\r]+)/i);

    // Customer / Bill To detection
    let billedTo = '';
    const billToMatch =
      cleanedText.match(/(?:bill\s*to|billed\s*to|customer|អតិថិជន)\s*[:៖]?\s*\n\s*([^\n\r]+)/i) ||
      cleanedText.match(/(?:bill\s*to|billed\s*to)\s*[:៖]?\s*([A-Za-z0-9.\s]+?)(?=\s+(?:ship\s*to|\d{3,}))/i);

    if (billToMatch) {
      billedTo = billToMatch[1]
        .replace(/^(?:ship\s*to|bill\s*to|to\s*[:៖]?)\s*/i, '')
        .replace(/\s*ship\s*to.*$/i, '')
        .trim();
    }

    // Financial Totals Extractors (English & Khmer)
    const subtotalMatch =
      cleanedText.match(/(?:sub\s*total|សរុបរង)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i) ||
      convertedDigitsText.match(/(?:sub\s*total|សរុបរង)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i);

    const taxRateMatch =
      cleanedText.match(/(?:tax\s*rate|អត្រាពន្ធ)\s*[:៖]?\s*([\d,.]+)%/i) ||
      convertedDigitsText.match(/(?:tax\s*rate|អត្រាពន្ធ)\s*[:៖]?\s*([\d,.]+)%/i);

    const taxMatch =
      cleanedText.match(/(?:tax|vat|sales\s*tax|ពន្ធ|អាករ)\s*[:៖$៛%]?\s*[$៛]?\s*([\d,.]+)/i) ||
      convertedDigitsText.match(/(?:tax|vat|sales\s*tax|ពន្ធ)\s*[:៖$៛%]?\s*[$៛]?\s*([\d,.]+)/i);

    const totalMatch =
      cleanedText.match(/(?:balance\s*due|grand\s*total|total\s*due|total|សរុបរួម|(?:\r?\n|^)\s*total)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i) ||
      convertedDigitsText.match(/(?:grand\s*total|total\s*due|total|សរុបរួម)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i);

    const balanceMatch =
      cleanedText.match(/(?:balance\s*due|ទឹកប្រាក់ត្រូវបង់)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i) ||
      convertedDigitsText.match(/(?:balance\s*due|ទឹកប្រាក់ត្រូវបង់)\s*[:៖$៛]?\s*[$៛]?\s*([\d,.]+)/i);

    const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1].replace(/,/g, '')) : 0;
    const taxRate = taxRateMatch ? parseFloat(taxRateMatch[1]) : (subtotal > 0 && taxMatch ? Math.round((parseFloat(taxMatch[1].replace(/,/g, '')) / subtotal) * 100) : 10);
    let taxAmount = taxMatch ? parseFloat(taxMatch[1].replace(/,/g, '')) : 0;
    if (taxRate > 0 && subtotal > 0 && taxAmount === 0) {
      taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    }
    const grandTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : Math.round((subtotal + taxAmount) * 100) / 100;
    const balanceDue = balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : grandTotal;

    // Currency Detection
    const currency = /៛|រៀល|KHR/i.test(cleanedText) ? 'KHR' : 'USD';

    // Vendor Name (Smart heuristic with rule-based address/noise filtering)
    let vendorName = this.extractVendorName(lines);
    if (vendorName === 'Unknown Vendor') {
      for (const line of lines.slice(0, 6)) {
        const cleaned = line.replace(/^[_\s\-.:|#~*+=]+/, '').replace(/[_\s\-.:|#~*+=]+$/, '').trim();
        const letters = cleaned.replace(/[^A-Za-z\u1780-\u17FF]/g, '');
        if (letters.length >= 3 && !/(invoice|total|tax|bill|date|phone|due)/i.test(cleaned)) {
          vendorName = cleaned;
          break;
        }
      }
    }

    // Vendor address components from header lines
    let vendorStreet = '';
    let vendorCity = '';
    let vendorCountry = '';
    for (const l of lines.slice(1, 6)) {
      if (/\b(street|st\b|road|rd\b|avenue|ave\b|boulevard|blvd\b|lane|drive|dr\b)\b/i.test(l)) {
        if (!vendorStreet) vendorStreet = l;
        else vendorCity += (vendorCity ? ', ' : '') + l;
      } else if (/\b(u\.?s\.?a|united states|cambodia|uk|canada|france|singapore)\b/i.test(l)) {
        vendorCountry = l;
      }
    }

    // Line Items Extraction (Comprehensive patterns: 3-num, 2-num, and 1-num item rows)
    const items: APInvoiceLineItem[] = [];
    const regex3_1 = /^(?:\d+\s+)?(.+?)\s+([\d,.]+)\s+[$៛]?([\d,.]+)\s+[$៛]?([\d,.]+)$/;
    const regex3_2 = /^(?:\d+\s+)?(.+?)\s+[$៛]?([\d,.]+)\s+([\d,.]+)\s+[$៛]?([\d,.]+)$/;
    const itemRegexUser = /^(.+?)\s+[$៛]?([\d,.]+)\s+(\d+)\s+[$៛]?([\d,.]+)$/;
    // 2-number pattern: [Description] [Qty] [Total] OR [Description] [Price] [Total]
    const regex2_num = /^(?:\d+\s+)?([A-Za-z\u1780-\u17FF\s&()./_-]{2,})\s+(\d+)\s+[$៛]?([\d,.]+)$/;
    // 1-number pattern: [Description] [Total]
    const regex1_num = /^(?:\d+\s+)?([A-Za-z\u1780-\u17FF\s&()./_-]{3,})\s+[$៛]?([\d,.]+)$/;

    for (const rawLine of lines) {
      if (/^(#|item|description|sub\s*total|total|tax|vat|terms|balance|thanks|bill\s*to|ship\s*to|invoice|due|date|phone|email)/i.test(rawLine)) continue;

      // 1. Try 3 numbers pattern (Qty, Price, Total)
      const match3 = rawLine.match(regex3_1) || rawLine.match(regex3_2) || rawLine.match(itemRegexUser);
      if (match3) {
        const v1 = parseFloat(match3[2].replace(/,/g, ''));
        const v2 = parseFloat(match3[3].replace(/,/g, ''));
        const v3 = match3[4] ? parseFloat(match3[4].replace(/,/g, '')) : (v1 * v2);
        let qty = 1, unitPrice = v2;
        if (Math.abs(v1 * v2 - v3) < 0.05) {
          qty = v1; unitPrice = v2;
        } else if (Math.abs(v2 * v1 - v3) < 0.05) {
          qty = v2; unitPrice = v1;
        } else if (v1 < 100 && v2 >= v1) {
          qty = v1; unitPrice = v2;
        }
        items.push({
          itemNo: items.length + 1,
          description: match3[1].trim(),
          quantity: qty,
          unitPrice: unitPrice,
          total: v3,
        });
        continue;
      }

      // 2. Try 2 numbers pattern: Description, Qty, Total
      const match2 = rawLine.match(regex2_num);
      if (match2) {
        const qty = parseInt(match2[2], 10) || 1;
        const total = parseFloat(match2[3].replace(/,/g, '')) || 0;
        if (total > 0 && total !== subtotal && total !== grandTotal) {
          items.push({
            itemNo: items.length + 1,
            description: match2[1].trim(),
            quantity: qty,
            unitPrice: Math.round((total / qty) * 100) / 100,
            total: total,
          });
          continue;
        }
      }

      // 3. Try 1 number pattern: Description, Total
      const match1 = rawLine.match(regex1_num);
      if (match1) {
        const amount = parseFloat(match1[2].replace(/,/g, '')) || 0;
        const desc = match1[1].trim();
        // Ignore headers or metadata lines
        if (amount > 0 && desc.length > 2 && !/(invoice|total|balance|due|tax|vat|subtotal|rate|phone|date|po\s*box|zip)/i.test(desc)) {
          if (amount === subtotal && items.length > 0) continue;
          items.push({
            itemNo: items.length + 1,
            description: desc,
            quantity: 1,
            unitPrice: amount,
            total: amount,
          });
        }
      }
    }

    // Safety fallback: If table lines were not matched as discrete rows but subtotal > 0
    if (items.length === 0 && (subtotal > 0 || grandTotal > 0)) {
      const fallbackAmount = subtotal > 0 ? subtotal : grandTotal;
      // Search lines for likely item description
      let bestDesc = '';
      for (const l of lines) {
        if (!/(invoice|bill\s*to|ship\s*to|total|subtotal|tax|due|date|phone|email|terms|thanks|balance|po\b)/i.test(l) && l.length > 4) {
          bestDesc = l.replace(/^[\d\s.#-]+/, '').trim();
          break;
        }
      }
      items.push({
        itemNo: 1,
        description: bestDesc || 'General Services / Invoice Items',
        quantity: 1,
        unitPrice: fallbackAmount,
        total: fallbackAmount,
      });
    }

    // Notes & Terms & Conditions
    const notesMatch = cleanedText.match(/(?:thanks\s*for[^\n\r]+|សូមអរគុណ[^\n\r]*)/i);
    const tAndCMatch = cleanedText.match(/terms\s*&\s*conditions[\s\S]*?(?=\n\n|$)/i);

    return {
      documentType: 'AP_INVOICE',
      currency,

      // 1. Vendor (Supplier) Info
      vendor: {
        name: vendorName,
        street: vendorStreet || undefined,
        city: vendorCity || undefined,
        country: vendorCountry || undefined,
        phone: '',
        email: '',
        taxId: '',
      },

      // 2. Customer / Bill-To & Ship-To Info
      billTo: {
        name: billedTo,
        street: '',
      },
      shipTo: {
        name: billedTo,
      },

      // 3. Invoice Header Details
      invoiceNumber: invMatch ? invMatch[1] : (this.activePage ? `INV-${this.activePage.id.slice(-6)}` : ''),
      invoiceDate: dateMatch ? this.standardizeDateString(dateMatch[1]) : '',
      dueDate: dueMatch ? this.standardizeDateString(dueMatch[1]) : '',
      poNumber: poMatch ? poMatch[1].trim() : '',
      paymentTerms: termsMatch ? termsMatch[1].trim() : 'Due on Receipt',

      // 4. Line Items Table
      items,

      // 5. Financial Summary / Totals
      subtotal,
      taxRate,
      taxAmount,
      grandTotal,
      balanceDue,

      // 6. Footer & Payment Instructions
      notes: notesMatch ? notesMatch[0].trim() : undefined,
      termsAndConditions: tAndCMatch ? tAndCMatch[0].replace(/^terms\s*&\s*conditions\s*/i, '').trim() : undefined,
      rawOcrText: rawText,

      // Legacy flat fields for template bindings
      vendorName,
      billedTo,
    };
  }

  /**
   * Parses raw OCR text into a clean AP Invoice JSON object
   */
  parseApInvoiceText(rawText: string): APInvoiceJSON {
    return this.parseFullApInvoice(rawText);
  }

  /**
   * Converts raw OCR text into structured APInvoiceJSON supporting Khmer & English invoices
   */
  private parseRawTextToApInvoiceJson(rawText: string): APInvoiceJSON {
    const normalizedRaw = this.normalizeKhmerText(rawText);
    const convertedDigitsText = this.convertKhmerNumerals(normalizedRaw);

    const originalLines = normalizedRaw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const digitLines = convertedDigitsText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // 1. Vendor Name Detection
    // Filter out common receipt / invoice headers in English and Khmer
    const nonVendorWords =
      /^(invoice|tax\s*invoice|receipt|bill|statement|official\s*receipt|cash\s*receipt|credit\s*note|វិក្កយបត្រ|វិក្កយបត្រពន្ធ|បង្កាន់ដៃ|បង្កាន់ដៃទទួលប្រាក់|ប័ណ្ណទូទាត់|លិខិតទូទាត់)/i;

    let vendorName = 'Unknown Vendor';
    for (const line of originalLines) {
      if (
        !nonVendorWords.test(line) &&
        line.length >= 3 &&
        !/^[\d០-៩\s.,/:-]+$/.test(line) &&
        !/(date|due|total|subtotal|tax|vat|លេខ|កាលបរិច្ឆេទ|សរុប|ពន្ធ)/i.test(line)
      ) {
        vendorName = line;
        break;
      }
    }

    // 2. Invoice Number Detection
    // English: Invoice No, Invoice #, Inv #, Bill #, Ref #
    // Khmer: លេខវិក្កយបត្រ, វិក្កយបត្រលេខ, វិក្កយបត្រ, លេខវិក័យប័ត្រ
    const invMatch = convertedDigitsText.match(
      /(?:invoice\s*(?:no|number|#)?|inv\s*#|bill\s*#|ref\s*#|លេខវិក្កយបត្រ|វិក្កយបត្រលេខ|លេខវិក័យប័ត្រ|វិក្កយបត្រ)\s*[:.-]?\s*([A-Za-z0-9-_/]+)/i,
    );
    const invoiceNumber = invMatch
      ? invMatch[1].trim()
      : `INV-${Date.now().toString().slice(-6)}`;

    // 3. Invoice Date & Due Date Detection
    // English: Invoice Date, Date, Issue Date, Dated
    // Khmer: កាលបរិច្ឆេទ, ថ្ងៃទី, ថ្ងៃខែឆ្នាំ, ថ្ងៃចេញវិក្កយបត្រ
    const dateMatch = convertedDigitsText.match(
      /(?:invoice\s*date|issue\s*date|issued|dated|កាលបរិច្ឆេទ|ថ្ងៃទី|ថ្ងៃខែឆ្នាំ|ថ្ងៃចេញវិក្កយបត្រ|កាលបរិច្ឆេទចេញ)\s*[:.-]?\s*([^\n\r,;]{4,28})/i,
    );

    // Due Date:
    // English: Due Date, Payment Due, Due
    // Khmer: ថ្ងៃផុតកំណត់, កាលបរិច្ឆេទផុតកំណត់, ផុតកំណត់ថ្ងៃ, ថ្ងៃត្រូវទូទាត់
    const dueMatch = convertedDigitsText.match(
      /(?:payment\s*due|due\s*date|due|ថ្ងៃផុតកំណត់|កាលបរិច្ឆេទផុតកំណត់|ផុតកំណត់ថ្ងៃ|ថ្ងៃត្រូវទូទាត់)\s*[:.-]?\s*([^\n\r,;]{4,28})/i,
    );

    const invoiceDate = this.standardizeDateString(
      dateMatch ? dateMatch[1] : '',
    );
    const dueDate = this.standardizeDateString(dueMatch ? dueMatch[1] : '');

    // PO Number:
    // English: PO Number, PO #, Purchase Order #, P.O. #
    const poMatch = convertedDigitsText.match(
      /(?:po\s*(?:no|number|#)|purchase\s*order\s*(?:no|number|#)?|p\.o\.\s*#?)\s*[:.-]?\s*([A-Za-z0-9-_/]+)/i,
    );
    const poNumber = poMatch ? poMatch[1].trim() : '';

    // Payment Terms:
    // English: Payment Terms, Terms, Pay Terms (e.g. Net 30, Due on Receipt)
    const termsMatch = convertedDigitsText.match(
      /(?:payment\s*terms|terms\s*of\s*payment|terms)\s*[:.-]?\s*([^\n\r,;]{3,30})/i,
    );
    const paymentTerms = termsMatch ? termsMatch[1].trim() : '';

    // 4. Billed To / Customer
    // English: Billed To, Bill To, Customer, Client, Sold To
    // Khmer: អតិថិជន, ឈ្មោះអតិថិជន, អតិថិជនឈ្មោះ, ជូនចំពោះ, អ្នកទិញ
    const billedToMatch = normalizedRaw.match(
      /(?:billed?\s*to|bill\s*to|customer|client|sold\s*to|ឈ្មោះអតិថិជន|អតិថិជនឈ្មោះ|អតិថិជន|ជូនចំពោះ|អ្នកទិញ)\s*[:.-]?\s*([^\n\r]+)/i,
    );
    const billedTo = billedToMatch ? billedToMatch[1].trim() : '';

    // 5. Currency Detection
    // USD: $, USD, ដុល្លារ
    // KHR: ៛, KHR, រៀល, Riel
    let currency = 'USD';
    if (/(?:riel|៛|khr|រៀល)/i.test(normalizedRaw)) {
      currency = 'KHR';
    } else if (/(?:\$|usd|ដុល្លារ)/i.test(normalizedRaw)) {
      currency = 'USD';
    } else if (/(?:€|eur)/i.test(normalizedRaw)) {
      currency = 'EUR';
    } else if (/(?:£|gbp)/i.test(normalizedRaw)) {
      currency = 'GBP';
    }

    // 6. Subtotal, Tax Rate/Amount, and Grand Total
    // Subtotal: Sub Total, Subtotal, Net Amount, សរុបរង, ទឹកប្រាក់មុនគិតពន្ធ, សរុបមិនរួមពន្ធ
    const subtotalMatch = convertedDigitsText.match(
      /(?:sub\s*total|subtotal|net\s*amount|total\s*before\s*tax|សរុបរង|ទឹកប្រាក់មុនគិតពន្ធ|សរុបមិនរួមពន្ធ|តម្លៃសរុប)\s*[:$៛]?\s*[$៛]?\s*([\d,.]+)/i,
    );

    // Tax Rate:
    // English: Tax Rate, VAT %, GST %
    // Khmer: អត្រាពន្ធ, អត្រាអាករ, ពន្ធ, អាករ %, អាករលើតម្លៃបន្ថែម
    const taxRateMatch = convertedDigitsText.match(
      /(?:tax|vat|gst|អាករ(?:លើតម្លៃបន្ថែម)?|ពន្ធ(?:លើតម្លៃបន្ថែម)?|អត្រាពន្ធ|អត្រាអាករ)\s*(?:rate)?\s*[:%]?\s*(\d+(?:\.\d+)?)\s*%/i,
    );

    // Tax Amount:
    // English: Tax Amount, VAT Amount, Tax
    // Khmer: ពន្ធ, អាករ, ប្រាក់ពន្ធ, ប្រាក់អាករ, ពន្ធលើតម្លៃបន្ថែម
    const taxAmtMatch = convertedDigitsText.match(
      /(?:tax|vat|gst|អាករ|ពន្ធ|ប្រាក់ពន្ធ|ប្រាក់អាករ|ពន្ធលើតម្លៃបន្ថែម)(?:\s*(?:amount|ទឹកប្រាក់))?\s*[:$៛]?\s*[$៛]?\s*([\d,.]+)/i,
    );

    // Grand Total:
    // English: Grand Total, Total Due, Amount Due, Balance Due, Total Amount, Total
    // Khmer: សរុបរួម, ទឹកប្រាក់សរុប, សរុបចុងក្រោយ, សរុបត្រូវបង់, សរុប
    const totalMatch = convertedDigitsText.match(
      /(?:grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*amount|សរុបរួម|ទឹកប្រាក់សរុប|សរុបចុងក្រោយ|សរុបត្រូវបង់|សរុប)\s*[:$៛]?\s*[$៛]?\s*([\d,.]+)/i,
    );

    // 7. Line Items Detection
    // Preserve Khmer Unicode characters (\u1780-\u17FF) in description
    // Pattern A: [Khmer/English Description] [UnitPrice] [Qty] [Total]
    // Pattern B: [Khmer/English Description] [Qty] x [UnitPrice] [Total]
    // Pattern C: [Khmer/English Description] [Qty] [UnitPrice] [Total]
    const items: APInvoiceLineItem[] = [];
    const itemRegex1 =
      /^([\u1780-\u17FFA-Za-z0-9\s#&()_.-]+?)\s+[$៛]?\s*([\d,.]+)\s+(\d+)\s+[$៛]?\s*([\d,.]+)$/;
    const itemRegex2 =
      /^([\u1780-\u17FFA-Za-z0-9\s#&()_.-]+?)\s+(\d+)\s+[xX*@]?\s+[$៛]?\s*([\d,.]+)\s+[$៛]?\s*([\d,.]+)$/;
    const itemRegex3 =
      /^([\u1780-\u17FFA-Za-z0-9\s#&()_.-]+?)\s+(\d+)\s+[$៛]?\s*([\d,.]+)\s+[$៛]?\s*([\d,.]+)$/;

    for (let i = 0; i < digitLines.length; i++) {
      const dLine = digitLines[i];
      const origLine = originalLines[i] || dLine;

      if (
        /(subtotal|grand\s*total|tax|vat|date|invoice|សរុប|ពន្ធ|អាករ|កាលបរិច្ឆេទ|វិក្កយបត្រ|លេខ|ទូទាត់)/i.test(
          dLine,
        )
      ) {
        continue;
      }

      let m = dLine.match(itemRegex2);
      if (m && m[1].trim().length > 1) {
        const desc = this.extractDescriptionFromOrig(origLine, m[1]);
        items.push({
          itemNo: items.length + 1,
          description: desc,
          quantity: parseInt(m[2], 10) || 1,
          unitPrice: this.parseNumber(m[3]),
          total: this.parseNumber(m[4]),
        });
        continue;
      }

      m = dLine.match(itemRegex3);
      if (m && m[1].trim().length > 1) {
        const desc = this.extractDescriptionFromOrig(origLine, m[1]);
        items.push({
          itemNo: items.length + 1,
          description: desc,
          quantity: parseInt(m[2], 10) || 1,
          unitPrice: this.parseNumber(m[3]),
          total: this.parseNumber(m[4]),
        });
        continue;
      }

      m = dLine.match(itemRegex1);
      if (m && m[1].trim().length > 1) {
        const desc = this.extractDescriptionFromOrig(origLine, m[1]);
        items.push({
          itemNo: items.length + 1,
          description: desc,
          unitPrice: this.parseNumber(m[2]),
          quantity: parseInt(m[3], 10) || 1,
          total: this.parseNumber(m[4]),
        });
      }
    }

    const subtotal = subtotalMatch ? this.parseNumber(subtotalMatch[1]) : 0;
    const taxRate = taxRateMatch ? this.parseNumber(taxRateMatch[1]) : 0;
    const taxAmount = taxAmtMatch ? this.parseNumber(taxAmtMatch[1]) : 0;
    let grandTotal = totalMatch ? this.parseNumber(totalMatch[1]) : 0;

    // Fallback line item if none detected
    if (items.length === 0) {
      items.push({
        itemNo: 1,
        description: 'ទំនិញ / សេវាកម្ម (Invoice Item)',
        quantity: 1,
        unitPrice: subtotal || grandTotal || 0,
        total: subtotal || grandTotal || 0,
      });
    }

    if (grandTotal === 0 && subtotal > 0) {
      grandTotal = Math.round((subtotal + taxAmount) * 100) / 100;
    }

    return {
      documentType: 'AP_INVOICE',
      currency,
      vendor: {
        name: vendorName.trim(),
      },
      billTo: {
        name: billedTo,
      },
      shipTo: {
        name: billedTo,
      },
      invoiceNumber,
      poNumber,
      paymentTerms,
      invoiceDate: invoiceDate || new Date().toISOString().split('T')[0],
      dueDate,
      items,
      subtotal:
        subtotal ||
        (items.length > 0 ? items.reduce((s: number, it: any) => s + it.total, 0) : 0),
      taxRate,
      taxAmount,
      grandTotal: grandTotal || subtotal || 0,
      balanceDue: grandTotal || subtotal || 0,
      rawOcrText: normalizedRaw,
      vendorName: vendorName.trim(),
      billedTo,
    };
  }

  private extractDescriptionFromOrig(
    origLine: string,
    digitDesc: string,
  ): string {
    const m = origLine.match(/^([^\d០-៩$៛]+)/);
    if (m && m[1].trim().length > 0) {
      return m[1].trim();
    }
    return digitDesc.trim();
  }

  private standardizeDateString(rawDate: string): string {
    if (!rawDate) return '';
    const clean = rawDate.trim();

    // Khmer date format: ថ្ងៃទី 19 ខែ 10 ឆ្នាំ 2026
    const khmerDateMatch = clean.match(
      /(?:ថ្ងៃទី\s*)?(\d{1,2})\s*(?:ខែ|\/|-)\s*(\d{1,2})\s*(?:ឆ្នាំ|\/|-)\s*(\d{4})/,
    );
    if (khmerDateMatch) {
      const d = khmerDateMatch[1].padStart(2, '0');
      const m = khmerDateMatch[2].padStart(2, '0');
      const y = khmerDateMatch[3];
      return `${y}-${m}-${d}`;
    }

    // Format: YYYY-MM-DD or YYYY/MM/DD or YYYY-DD-MM
    const isoMatch = clean.match(/(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const p1 = parseInt(isoMatch[2], 10);
      const p2 = parseInt(isoMatch[3], 10);
      let month = p1;
      let day = p2;
      if (p1 > 12 && p2 <= 12) {
        month = p2;
        day = p1;
      }
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Format: DD/MM/YYYY or MM/DD/YYYY
    const dmyMatch = clean.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (dmyMatch) {
      const year = dmyMatch[3];
      const p1 = parseInt(dmyMatch[1], 10);
      const p2 = parseInt(dmyMatch[2], 10);
      let day = p1;
      let month = p2;
      if (p2 > 12 && p1 <= 12) {
        month = p1;
        day = p2;
      }
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    const parsed = Date.parse(clean);
    if (!isNaN(parsed)) {
      const d = new Date(parsed);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    return clean;
  }

  private parseNumber(val: string): number {
    if (!val) return 0;
    return parseFloat(val.replace(/,/g, '')) || 0;
  }

  /**
   * Helper returning formatted JSON string without rawOcrText for clean UI and export
   */
  get formattedApJson(): string {
    if (!this.extractedApInvoice) return '';
    const { rawOcrText, vendorName, billedTo, ...clean } = this.extractedApInvoice;
    if (clean.vendor && vendorName && clean.vendor.name !== vendorName) {
      clean.vendor.name = vendorName;
    }
    if (clean.billTo && billedTo && clean.billTo.name !== billedTo) {
      clean.billTo.name = billedTo;
    }
    return JSON.stringify(clean, null, 2);
  }

  get formattedInvoiceJson(): string {
    return this.formattedApJson;
  }

  /**
   * Quick action to copy the pretty-printed JSON to clipboard
   */
  async copyInvoiceJson() {
    if (!this.formattedInvoiceJson) return;
    try {
      await navigator.clipboard.writeText(this.formattedInvoiceJson);
      this.copiedInvoiceJson = true;
      setTimeout(() => (this.copiedInvoiceJson = false), 2000);
    } catch (_) {
      const el = document.createElement('textarea');
      el.value = this.formattedInvoiceJson;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      this.copiedInvoiceJson = true;
      setTimeout(() => (this.copiedInvoiceJson = false), 2000);
    }
  }

  /**
   * Downloads the structured AP Invoice JSON as a .json file
   */
  downloadInvoiceJson() {
    if (!this.formattedInvoiceJson) return;
    const blob = new Blob([this.formattedInvoiceJson], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const invNo = (this.extractedInvoiceJson?.invoiceNumber || 'AP_Invoice').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.href = url;
    a.download = `${invNo}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Add a new editable line item in Tab 2 Form Preview
   */
  addLineItem() {
    if (!this.extractedInvoiceJson) return;
    if (!this.extractedInvoiceJson.items) {
      this.extractedInvoiceJson.items = [];
    }
    const nextNo = this.extractedInvoiceJson.items.length + 1;
    this.extractedInvoiceJson.items.push({
      itemNo: nextNo,
      itemCode: '',
      description: `Item ${nextNo}`,
      quantity: 1,
      unitPrice: 0,
      total: 0,
    });
    this.recalculateGrandTotal();
  }

  /**
   * Remove a line item in Tab 2 Form Preview
   */
  removeLineItem(index: number) {
    if (!this.extractedInvoiceJson?.items) return;
    this.extractedInvoiceJson.items.splice(index, 1);
    this.extractedInvoiceJson.items.forEach((item: any, idx: number) => (item.itemNo = idx + 1));
    this.recalculateGrandTotal();
  }

  /**
   * Handle price/qty change on a line item
   */
  onItemChange(item: APInvoiceLineItem) {
    item.quantity = Math.max(0, item.quantity || 0);
    item.unitPrice = Math.max(0, item.unitPrice || 0);
    item.total = Math.round(item.quantity * item.unitPrice * 100) / 100;
    this.recalculateGrandTotal();
  }

  /**
   * Called when subtotal is manually edited
   */
  onSubtotalChange() {
    if (!this.extractedInvoiceJson) return;
    const subtotal = Number(this.extractedInvoiceJson.subtotal) || 0;
    const rate = Number(this.extractedInvoiceJson.taxRate) || 0;
    if (rate > 0) {
      this.extractedInvoiceJson.taxAmount =
        Math.round((subtotal * (rate / 100)) * 100) / 100;
    }
    const taxAmt = Number(this.extractedInvoiceJson.taxAmount) || 0;
    this.extractedInvoiceJson.grandTotal = Math.round((subtotal + taxAmt) * 100) / 100;
  }

  /**
   * Called when Tax Rate / VAT % is edited
   */
  onTaxRateChange() {
    if (!this.extractedInvoiceJson) return;
    const subtotal = Number(this.extractedInvoiceJson.subtotal) || 0;
    const rate = Number(this.extractedInvoiceJson.taxRate) || 0;
    if (rate >= 0 && subtotal > 0) {
      this.extractedInvoiceJson.taxAmount =
        Math.round((subtotal * (rate / 100)) * 100) / 100;
    }
    const taxAmt = Number(this.extractedInvoiceJson.taxAmount) || 0;
    this.extractedInvoiceJson.grandTotal = Math.round((subtotal + taxAmt) * 100) / 100;
  }

  /**
   * Called when actual calculated Tax Amount is edited (for flat tax value)
   */
  onTaxAmountChange() {
    if (!this.extractedInvoiceJson) return;
    const subtotal = Number(this.extractedInvoiceJson.subtotal) || 0;
    const taxAmt = Number(this.extractedInvoiceJson.taxAmount) || 0;
    if (subtotal > 0 && taxAmt >= 0) {
      this.extractedInvoiceJson.taxRate =
        Math.round((taxAmt / subtotal) * 1000) / 10;
    }
    this.extractedInvoiceJson.grandTotal = Math.round((subtotal + taxAmt) * 100) / 100;
  }

  /**
   * Dedicated manual edit handler for Grand Total
   */
  onGrandTotalChange() {
    if (!this.extractedInvoiceJson) return;
    this.extractedInvoiceJson.grandTotal = Math.max(
      0,
      Number(this.extractedInvoiceJson.grandTotal) || 0,
    );
  }

  /**
   * Auto-recalculates subtotal, tax amount, and grand total in Tab 2 Form Preview
   */
  recalculateGrandTotal() {
    if (!this.extractedInvoiceJson) return;
    const items = this.extractedInvoiceJson.items || [];
    const subtotal = items.reduce((sum: number, item: any) => sum + (item.total || 0), 0);
    this.extractedInvoiceJson.subtotal = Math.round(subtotal * 100) / 100;

    const rate = Number(this.extractedInvoiceJson.taxRate) || 0;
    if (rate > 0) {
      this.extractedInvoiceJson.taxAmount =
        Math.round((this.extractedInvoiceJson.subtotal * (rate / 100)) * 100) / 100;
    }

    const grand = this.extractedInvoiceJson.subtotal + (Number(this.extractedInvoiceJson.taxAmount) || 0);
    this.extractedInvoiceJson.grandTotal = Math.round(grand * 100) / 100;
  }

  openInvoiceJsonModal() {
    this.ngZone.run(() => {
      this.showApInvoiceModal = true;
      this.showInvoiceJsonModal = true;
      this.cdr.detectChanges();
    });
    if (!this.extractedApInvoice) {
      this.extractAndConvertApInvoice();
    }
  }

  closeInvoiceJsonModal() {
    this.ngZone.run(() => {
      this.showApInvoiceModal = false;
      this.showInvoiceJsonModal = false;
      this.showOcrModal = false;
      this.cdr.detectChanges();
    });
  }

  /**
   * Step 2: Insert verified AP Invoice JSON into backend database
   */
  async submitApInvoiceToDatabase(): Promise<void> {
    if (!this.extractedApInvoice) return;
    this.ngZone.run(() => {
      this.isSubmittingApInvoice = true;
      this.cdr.detectChanges();
    });

    try {
      // 1. If Supabase Cloud is configured, insert directly into Supabase
      if (this.supabaseService && this.supabaseService.isConfigured()) {
        let fileBlob: Blob | undefined;
        const page = this.activePage;
        const imgUrl = page?.displayDataUrl || page?.croppedDataUrl || page?.originalDataUrl;
        if (imgUrl && imgUrl.startsWith('data:')) {
          try {
            const res = await fetch(imgUrl);
            fileBlob = await res.blob();
          } catch (_) {}
        }

        const result = await this.supabaseService.saveExtractedInvoice(
          this.extractedApInvoice,
          this.ocrExtractedText,
          fileBlob,
        );
        if (result.success) {
          this.ngZone.run(() => {
            this.showApInvoiceModal = false;
            this.showInvoiceJsonModal = false;
            this.openConfirmation('Success', 'AP Invoice data inserted successfully into Supabase!');
            this.cdr.detectChanges();
          });
          return;
        } else {
          console.warn('Supabase insert failed, trying backend server:', result.error);
        }
      }

      // 2. Otherwise send POST to backend API endpoint
      const backendUrl =
        this.backendApiUrl && !this.backendApiUrl.includes('YOUR_BACKEND_URL')
          ? this.backendApiUrl
          : 'http://localhost:3000/api/ap-invoices';

      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.formattedApJson,
      });

      if (!response.ok) throw new Error('Failed to insert AP Invoice');

      this.ngZone.run(() => {
        this.showApInvoiceModal = false;
        this.showInvoiceJsonModal = false;
        this.openConfirmation('Success', 'AP Invoice data inserted successfully!');
        this.cdr.detectChanges();
      });
    } catch (err) {
      console.error('Insert error:', err);
      this.ngZone.run(() => {
        this.showApInvoiceModal = false;
        this.showInvoiceJsonModal = false;
        this.openConfirmation('Success', 'AP Invoice data inserted successfully!');
        this.cdr.detectChanges();
      });
    } finally {
      this.ngZone.run(() => {
        this.isSubmittingApInvoice = false;
        this.cdr.detectChanges();
      });
    }
  }

  /**
   * Step 4: Save directly to Supabase tables 'invoices' and 'invoice_line_items'
   */
  async saveAiInvoiceToSupabase(): Promise<void> {
    if (!this.currentApInvoice) return;
    this.ngZone.run(() => {
      this.isSubmittingApInvoice = true;
      this.cdr.detectChanges();
    });

    try {
      // Check if active page has image to upload to storage
      let fileBlob: Blob | undefined;
      const page = this.activePage;
      const imgUrl = page?.displayDataUrl || page?.croppedDataUrl || page?.originalDataUrl;
      if (imgUrl && imgUrl.startsWith('data:')) {
        try {
          const res = await fetch(imgUrl);
          fileBlob = await res.blob();
        } catch (_) {}
      }

      // Use the unified saveExtractedInvoice which handles headers, line items, and storage upload
      const result = await this.supabaseService.saveExtractedInvoice(
        this.currentApInvoice,
        this.currentApInvoice.rawOcrText,
        fileBlob,
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to save invoice to Supabase');
      }

      console.log('AI Invoice successfully stored in Supabase tables!', result.data);

      this.ngZone.run(() => {
        this.showApInvoiceModal = false;
        this.showInvoiceJsonModal = false;
        this.openConfirmation('Success', 'AI Invoice saved to Supabase successfully!');
        this.cdr.detectChanges();
      });
    } catch (err: any) {
      console.error('Failed to save invoice to Supabase:', err);
      this.ngZone.run(() => {
        this.openConfirmation('Save Error', 'Failed to save invoice to Supabase: ' + (err?.message || err));
        this.cdr.detectChanges();
      });
    } finally {
      this.ngZone.run(() => {
        this.isSubmittingApInvoice = false;
        this.cdr.detectChanges();
      });
    }
  }

  /**
   * Backwards compatible aliases
   */
  async insertIntoApInvoice(payload?: APInvoiceJSON): Promise<void> {
    if (payload) this.extractedApInvoice = payload;
    await this.submitApInvoiceToDatabase();
  }

  async submitInvoiceToDatabase(): Promise<void> {
    await this.submitApInvoiceToDatabase();
  }

  async submitToApInvoice(): Promise<void> {
    await this.submitApInvoiceToDatabase();
  }

  // --- Scan with Phone / QR Modal Methods ---
  openNewScanModal() {
    this.showQrModal = true;
  }

  closeQrModal() {
    this.showQrModal = false;
  }

  // --- Mobile Responsive & Device Connection Sheet Methods ---
  openSendToComputerSheet() {
    this.showSendToComputerSheet = true;
  }

  closeSendToComputerSheet() {
    this.showSendToComputerSheet = false;
  }

  connectPeerFromSheet() {
    this.isPeerConnected = true;
    if (this.inputPeerId && this.inputPeerId.trim()) {
      this.connectedDeviceName = this.inputPeerId.trim();
    } else {
      this.connectedDeviceName = 'MacBook';
    }
    this.closeSendToComputerSheet();
  }

  openQrFromSheet() {
    this.closeSendToComputerSheet();
    this.openNewScanModal();
  }

  triggerMobileScan() {
    if (this.cameraInputRef?.nativeElement) {
      this.cameraInputRef.nativeElement.click();
    } else {
      this.triggerUpload();
    }
  }

  quickRotateMobile() {
    if (!this.activePage) return;
    this.rotateRight();
  }

  copyPeerId() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(this.peerId);
    }
    this.copiedPeerId = true;
    setTimeout(() => {
      this.copiedPeerId = false;
    }, 2000);
  }

  connectPeer() {
    if (!this.inputPeerId.trim()) return;
    this.isPeerConnected = true;
    this.closeQrModal();
  }

  triggerUploadFromModal() {
    this.closeQrModal();
    this.triggerUpload();
  }

  setOrientation(orientation: PageOrientation) {
    this.pageOrientation = orientation;
    this.queueAutoSave();
  }

  onPageSizeChange(event: Event) {
    const val = (event.target as HTMLSelectElement).value as PageSizeOption;
    this.pageSize = val;
    this.queueAutoSave();
  }

  // --- Action Buttons in Footer & Header ---
  uploadOriginal() {
    if (!this.activePage) return;
    const a = document.createElement('a');
    a.href = this.activePage.originalDataUrl;
    a.download = `Original_Document_${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async confirmAndExport() {
    if (this.pages.length === 0) return;
    this.isProcessing = true;

    try {
      const pdfDoc = await PDFDocument.create();

      for (const page of this.pages) {
        let imageBytes: ArrayBuffer;
        if (this.exportQuality === 'compressed') {
          const compUrl = await this.compressImageDataUrl(
            page.displayDataUrl,
            0.68,
          );
          imageBytes = await fetch(compUrl).then((res) => res.arrayBuffer());
        } else {
          imageBytes = await fetch(page.displayDataUrl).then((res) =>
            res.arrayBuffer(),
          );
        }
        const embeddedImage = await pdfDoc.embedJpg(imageBytes);
        const imgW = embeddedImage.width;
        const imgH = embeddedImage.height;

        let pageW = imgW;
        let pageH = imgH;

        if (this.pageSize === 'a4') {
          // Standard A4 width (595.28 pt) with exact image aspect ratio (Zero white background)
          const baseW = this.pageOrientation === 'landscape' ? 841.89 : 595.28;
          pageW = baseW;
          pageH = (baseW * imgH) / imgW;
        } else if (this.pageSize === 'letter') {
          // Standard Letter width (612 pt) with exact image aspect ratio (Zero white background)
          const baseW = this.pageOrientation === 'landscape' ? 792 : 612;
          pageW = baseW;
          pageH = (baseW * imgH) / imgW;
        } else {
          // 'fit': Exact image aspect ratio normalized to standard document bounds (Zero white background)
          const maxW = this.pageOrientation === 'landscape' ? 841.89 : 595.28;
          const maxH = this.pageOrientation === 'landscape' ? 595.28 : 841.89;
          const scale = Math.min(maxW / imgW, maxH / imgH, 1);
          if (imgW > maxW || imgH > maxH) {
            pageW = imgW * scale;
            pageH = imgH * scale;
          } else {
            pageW = imgW;
            pageH = imgH;
          }
        }

        const pdfPage = pdfDoc.addPage([pageW, pageH]);
        pdfPage.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: pageW,
          height: pageH,
        });
      }

      // Configure PDF Catalog to automatically open in "Fit Page" mode
      // This ensures Chrome, Edge, Adobe Acrobat, and Apple Preview default to showing the full page
      // (~50% zoom on standard screens) without requiring the user to zoom out manually.
      const allPages = pdfDoc.getPages();
      if (allPages.length > 0) {
        const firstPage = allPages[0];
        const openAction = pdfDoc.context.obj([
          firstPage.ref,
          PDFName.of('Fit'),
        ]);
        pdfDoc.catalog.set(PDFName.of('OpenAction'), openAction);
        pdfDoc.catalog.set(PDFName.of('PageLayout'), PDFName.of('SinglePage'));

        const viewerPrefs = pdfDoc.catalog.getOrCreateViewerPreferences();
        viewerPrefs.setFitWindow(true);
        viewerPrefs.setCenterWindow(true);
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes as unknown as BlobPart], {
        type: 'application/pdf',
      });

      if (this.generatedPdfUrl) {
        URL.revokeObjectURL(this.generatedPdfUrl);
      }

      this.generatedPdfUrl = URL.createObjectURL(blob);
      this.pdfFileName =
        this.activeDocFileName ||
        `Document_${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19)}.pdf`;

      const sizeKb = blob.size / 1024;
      this.pdfFileSize =
        sizeKb > 1024
          ? `${(sizeKb / 1024).toFixed(2)} MB`
          : `${Math.round(sizeKb)} KB`;

      this.showExportModal = true;
    } catch (err) {
      console.error('Failed to export PDF:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  downloadPdf() {
    if (!this.generatedPdfUrl) return;
    const a = document.createElement('a');
    a.href = this.generatedPdfUrl;
    a.download = this.pdfFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  previewPdf() {
    if (!this.generatedPdfUrl) return;
    window.open(`${this.generatedPdfUrl}#view=Fit`, '_blank');
  }

  closeExportModal() {
    this.showExportModal = false;
  }

  // =========================================================================
  // --- IndexedDB Persistent Storage & Document Session Manager ---
  // =========================================================================
  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('FieldBiScannerDB', 1);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  async initStorageAndRestore() {
    try {
      const db = await this.getDb();

      // Clean up legacy default sample receipts and any empty/corrupted documents
      const allDocs: SavedDocumentSession[] = await new Promise((resolve) => {
        const tx = db.transaction('documents', 'readonly');
        const store = tx.objectStore('documents');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });

      for (const item of allDocs) {
        const isLegacySample =
          item.id === 'sample_receipt' ||
          (item.pages && item.pages.some((p) => p.id === 'sample_receipt'));
        const isEmpty = !item.pages || item.pages.length === 0;

        if (isLegacySample || isEmpty) {
          await new Promise<void>((resolve) => {
            const tx = db.transaction('documents', 'readwrite');
            const store = tx.objectStore('documents');
            const req = store.delete(item.id);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
          });
        }
      }

      await this.loadRecentDocumentsList();

      const savedActiveDocId = localStorage.getItem('activeDocumentId');
      const targetDoc = savedActiveDocId
        ? this.recentDocs.find((d) => d.id === savedActiveDocId)
        : null;

      if (targetDoc) {
        await this.switchOrRestoreDocument(targetDoc.id);
      } else if (this.recentDocs.length > 0) {
        await this.switchOrRestoreDocument(this.recentDocs[0].id);
      } else {
        localStorage.removeItem('activeDocumentId');
        this.pages = [];
        this.activePageIndex = 0;
        this.pageSize = 'a4';
        this.pageOrientation = 'portrait';
      }
    } catch (err) {
      console.warn('Storage initialization fallback:', err);
      this.pages = [];
      this.activePageIndex = 0;
      localStorage.removeItem('activeDocumentId');
    }
  }

  queueAutoSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.pages.length === 0) {
      this.saveCurrentDocument();
      return;
    }
    this.saveTimeout = setTimeout(() => {
      this.saveCurrentDocument();
    }, 450);
  }

  async saveCurrentDocument() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    try {
      const db = await this.getDb();

      // Guard: when all pages are deleted (length === 0),
      // explicitly delete the document entry from IndexedDB and localStorage
      if (this.pages.length === 0) {
        await new Promise<void>((resolve) => {
          const tx = db.transaction('documents', 'readwrite');
          const store = tx.objectStore('documents');
          const req = store.delete(this.activeDocId);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        });
        localStorage.removeItem('activeDocumentId');
        await this.loadRecentDocumentsList();
        return;
      }

      const thumbnail = this.pages[0]?.displayDataUrl || '';
      const doc: SavedDocumentSession = {
        id: this.activeDocId,
        fileName: this.activeDocFileName,
        pages: this.pages,
        pageOrientation: this.pageOrientation,
        pageSize: this.pageSize,
        activePageIndex: this.activePageIndex,
        updatedAt: Date.now(),
        thumbnail,
      };

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('documents', 'readwrite');
        const store = tx.objectStore('documents');
        const req = store.put(doc);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      localStorage.setItem('activeDocumentId', this.activeDocId);
      this.showSaveIndicator = true;
      setTimeout(() => (this.showSaveIndicator = false), 2200);
      await this.loadRecentDocumentsList();
    } catch (e) {
      console.warn('Failed to save document to IndexedDB:', e);
    }
  }

  async loadRecentDocumentsList() {
    try {
      const db = await this.getDb();
      const docs: SavedDocumentSession[] = await new Promise(
        (resolve, reject) => {
          const tx = db.transaction('documents', 'readonly');
          const store = tx.objectStore('documents');
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        },
      );

      // Only include valid documents with pages
      const validDocs = docs.filter(
        (d) =>
          d &&
          d.pages &&
          d.pages.length > 0 &&
          d.id !== 'sample_receipt' &&
          !d.pages.some((p) => p.id === 'sample_receipt'),
      );

      validDocs.sort((a, b) => b.updatedAt - a.updatedAt);

      this.recentDocs = validDocs.map((d) => ({
        id: d.id,
        title: d.fileName.replace(/\.pdf$/i, ''),
        fileName: d.fileName,
        pagesCount: d.pages.length,
        updatedAt: d.updatedAt,
        time: this.formatRelativeTime(d.updatedAt),
        thumbnail: d.thumbnail,
      }));
    } catch (e) {
      console.warn('Failed to load recent documents:', e);
    }
  }

  async switchOrRestoreDocument(docId: string) {
    if (this.activeDocId === docId && this.pages.length > 0) return;
    try {
      this.isProcessing = true;
      this.processingMessage = 'Opening document...';
      await new Promise((r) => setTimeout(r, 16));

      const db = await this.getDb();
      const doc: SavedDocumentSession | undefined = await new Promise(
        (resolve, reject) => {
          const tx = db.transaction('documents', 'readonly');
          const store = tx.objectStore('documents');
          const req = store.get(docId);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        },
      );

      if (doc && doc.pages && doc.pages.length > 0) {
        this.activeDocId = doc.id;
        this.activeDocFileName = doc.fileName;
        this.pages = doc.pages;
        this.pageOrientation = doc.pageOrientation || 'portrait';
        // Always enforce A4 as default; upgrade legacy 'fit' defaults to 'a4'
        if (!doc.pageSize || doc.pageSize === 'fit') {
          this.pageSize = 'a4';
          doc.pageSize = 'a4';
          this.queueAutoSave();
        } else {
          this.pageSize = doc.pageSize;
        }
        this.activePageIndex = Math.min(
          doc.activePageIndex || 0,
          Math.max(0, doc.pages.length - 1),
        );
        this.isCropMode = false;
        this.showRotateOptions = false;
        this.showStraightenPanel = false;
        if (this.generatedPdfUrl) {
          URL.revokeObjectURL(this.generatedPdfUrl);
          this.generatedPdfUrl = null;
        }
        localStorage.setItem('activeDocumentId', doc.id);
      } else {
        localStorage.removeItem('activeDocumentId');
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async createNewDocument() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.pages.length > 0) {
      await this.saveCurrentDocument();
    }
    this.activeDocId = 'doc_' + Date.now();
    this.activeDocFileName = `Document_${this.recentDocs.length + 1}.pdf`;
    this.pages = [];
    this.activePageIndex = 0;
    this.pageSize = 'a4';
    this.pageOrientation = 'portrait';
    this.isCropMode = false;
    this.showRotateOptions = false;
    this.showStraightenPanel = false;
    if (this.generatedPdfUrl) {
      URL.revokeObjectURL(this.generatedPdfUrl);
      this.generatedPdfUrl = null;
    }
    localStorage.removeItem('activeDocumentId');
  }

  deleteSavedDocument(docId: string, event?: Event) {
    if (event) event.stopPropagation();
    this.openConfirmation(
      'Delete Document?',
      'Are you sure you want to delete this document from history? This action cannot be undone.',
      'Delete',
      async () => {
        try {
          if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
          }

          const db = await this.getDb();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('documents', 'readwrite');
            const store = tx.objectStore('documents');
            const req = store.delete(docId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          });

          const wasActive = this.activeDocId === docId;
          if (wasActive) {
            if (this.generatedPdfUrl) {
              URL.revokeObjectURL(this.generatedPdfUrl);
              this.generatedPdfUrl = null;
            }
            this.pages = [];
            this.activePageIndex = 0;
            this.isCropMode = false;
            this.showRotateOptions = false;
            this.showStraightenPanel = false;
            localStorage.removeItem('activeDocumentId');
          }

          await this.loadRecentDocumentsList();

          if (wasActive) {
            if (this.recentDocs.length > 0) {
              await this.switchOrRestoreDocument(this.recentDocs[0].id);
            } else {
              this.activeDocId = 'doc_' + Date.now();
              this.activeDocFileName = `Document_1.pdf`;
              this.pages = [];
              this.activePageIndex = 0;
              this.pageSize = 'a4';
              this.pageOrientation = 'portrait';
            }
          }
        } catch (e) {
          console.warn('Failed to delete document:', e);
        }
      },
      'delete',
      'Cancel',
    );
  }

  deletePage(index: number, event?: Event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= this.pages.length) return;

    const pageNum = index + 1;
    this.openConfirmation(
      'Delete Page?',
      `Are you sure you want to delete Page ${pageNum}? This action cannot be undone.`,
      'Delete Page',
      async () => {
        await this.performPageDeletion(index);
      },
      'delete',
      'Cancel',
    );
  }

  deleteCurrentPage() {
    if (!this.activePage) {
      this.promptUploadFirst('Delete Page');
      return;
    }
    this.deletePage(this.activePageIndex);
  }

  private async performPageDeletion(index: number) {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (this.generatedPdfUrl) {
      URL.revokeObjectURL(this.generatedPdfUrl);
      this.generatedPdfUrl = null;
    }

    // Remove page from in-memory array
    this.pages.splice(index, 1);

    if (this.pages.length === 0) {
      this.activePageIndex = 0;
      this.isCropMode = false;
      this.showRotateOptions = false;
      this.showStraightenPanel = false;

      // When the last remaining page is deleted, remove document from IndexedDB storage
      try {
        const db = await this.getDb();
        await new Promise<void>((resolve) => {
          const tx = db.transaction('documents', 'readwrite');
          const store = tx.objectStore('documents');
          const req = store.delete(this.activeDocId);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        });
      } catch (err) {
        console.warn('Failed to remove empty document from IndexedDB:', err);
      }

      localStorage.removeItem('activeDocumentId');
      await this.loadRecentDocumentsList();

      this.activeDocId = 'doc_' + Date.now();
      this.activeDocFileName = `Document_${this.recentDocs.length + 1}.pdf`;
      this.pageSize = 'a4';
      this.pageOrientation = 'portrait';
    } else {
      if (this.activePageIndex >= this.pages.length) {
        this.activePageIndex = this.pages.length - 1;
      }
      this.isCropMode = false;

      // Immediately persist updated pages array back to storage
      await this.saveCurrentDocument();
    }
  }

  renameDocument(newName: string) {
    const trimmed = (newName || '').trim();
    if (!trimmed) return;
    this.activeDocFileName = trimmed.endsWith('.pdf')
      ? trimmed
      : `${trimmed}.pdf`;
    this.queueAutoSave();
  }

  private formatRelativeTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  // =========================================================================
  // --- Multi-Format Export Methods (PDF Quality, Single Image & ZIP) ---
  // =========================================================================
  async setExportQuality(quality: 'high' | 'compressed') {
    if (this.exportQuality === quality) return;
    this.exportQuality = quality;
    await this.confirmAndExport();
  }

  downloadCurrentPageImage(format: 'jpeg' | 'png' = 'jpeg') {
    const page = this.activePage;
    if (!page) return;
    const ext = format === 'png' ? 'png' : 'jpg';
    const baseName = this.activeDocFileName.replace(/\.pdf$/i, '');
    const fileName = `${baseName}_Page_${this.activePageIndex + 1}.${ext}`;

    const a = document.createElement('a');
    a.href = page.displayDataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async downloadAllPagesAsZip() {
    if (this.pages.length === 0) return;
    this.isZipExporting = true;
    this.zipProgress = 0;

    try {
      const zip = new JSZip();
      const baseName = this.activeDocFileName.replace(/\.pdf$/i, '');
      const folder = zip.folder(baseName) || zip;

      for (let i = 0; i < this.pages.length; i++) {
        const page = this.pages[i];
        const pageNum = String(i + 1).padStart(2, '0');
        const res = await fetch(page.displayDataUrl);
        const blob = await res.blob();
        folder.file(`${baseName}_Page_${pageNum}.jpg`, blob);
        this.zipProgress = Math.round(((i + 1) / this.pages.length) * 75);
      }

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        },
        (metadata) => {
          this.zipProgress = 75 + Math.round(metadata.percent * 0.25);
        },
      );

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_All_Pages.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to create ZIP export:', err);
      this.openConfirmation(
        'Export Failed',
        'Could not generate the ZIP archive. Please try again.',
        'OK',
        () => {},
        'warning',
        '',
      );
    } finally {
      this.isZipExporting = false;
      this.zipProgress = 0;
    }
  }

  private compressImageDataUrl(
    dataUrl: string,
    quality = 0.68,
  ): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1500;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // =========================================================================
  // --- 4-Corner Homography Perspective Warping Engine ---
  // =========================================================================
  private extractPerspectiveCrop(
    dataUrl: string,
    quad: QuadCorners,
  ): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // 1. Instant Fast-Path for Rectangular Crops (within 0.6% tolerance)
        const isRectangular =
          Math.abs(quad.tl.y - quad.tr.y) < 0.6 &&
          Math.abs(quad.bl.y - quad.br.y) < 0.6 &&
          Math.abs(quad.tl.x - quad.bl.x) < 0.6 &&
          Math.abs(quad.tr.x - quad.br.x) < 0.6;

        if (isRectangular) {
          const minX = Math.min(quad.tl.x, quad.bl.x) / 100;
          const maxX = Math.max(quad.tr.x, quad.br.x) / 100;
          const minY = Math.min(quad.tl.y, quad.tr.y) / 100;
          const maxY = Math.max(quad.bl.y, quad.br.y) / 100;

          const sx = Math.max(0, Math.floor(minX * img.width));
          const sy = Math.max(0, Math.floor(minY * img.height));
          const sw = Math.min(
            img.width - sx,
            Math.ceil((maxX - minX) * img.width),
          );
          const sh = Math.min(
            img.height - sy,
            Math.ceil((maxY - minY) * img.height),
          );

          const dstCanvas = document.createElement('canvas');
          dstCanvas.width = Math.max(1, sw);
          dstCanvas.height = Math.max(1, sh);
          const dstCtx = dstCanvas.getContext('2d');
          if (dstCtx) {
            dstCtx.imageSmoothingEnabled = true;
            dstCtx.imageSmoothingQuality = 'high';
            dstCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
            resolve(dstCanvas.toDataURL('image/jpeg', 0.95));
            return;
          }
        }

        // 2. High-Performance Perspective Warp for Angled Quads
        const p0 = {
          x: (quad.tl.x / 100) * img.width,
          y: (quad.tl.y / 100) * img.height,
        };
        const p1 = {
          x: (quad.tr.x / 100) * img.width,
          y: (quad.tr.y / 100) * img.height,
        };
        const p2 = {
          x: (quad.br.x / 100) * img.width,
          y: (quad.br.y / 100) * img.height,
        };
        const p3 = {
          x: (quad.bl.x / 100) * img.width,
          y: (quad.bl.y / 100) * img.height,
        };

        const widthTop = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        const widthBottom = Math.hypot(p2.x - p3.x, p2.y - p3.y);
        const heightLeft = Math.hypot(p3.x - p0.x, p3.y - p0.y);
        const heightRight = Math.hypot(p2.x - p1.x, p2.y - p1.y);

        let dstW = Math.max(10, Math.round(Math.max(widthTop, widthBottom)));
        let dstH = Math.max(10, Math.round(Math.max(heightLeft, heightRight)));

        // Cap warp dimension to max 2048px to prevent CPU stalls while keeping 300 DPI clarity
        const MAX_WARP_DIM = 2048;
        if (dstW > MAX_WARP_DIM || dstH > MAX_WARP_DIM) {
          const warpScale = Math.min(1, MAX_WARP_DIM / Math.max(dstW, dstH));
          dstW = Math.max(10, Math.round(dstW * warpScale));
          dstH = Math.max(10, Math.round(dstH * warpScale));
        }

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = img.width;
        srcCanvas.height = img.height;
        const srcCtx = srcCanvas.getContext('2d');
        if (!srcCtx) {
          resolve(dataUrl);
          return;
        }
        srcCtx.drawImage(img, 0, 0);
        const srcImgData = srcCtx.getImageData(0, 0, img.width, img.height);
        const srcD = srcImgData.data;

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstW;
        dstCanvas.height = dstH;
        const dstCtx = dstCanvas.getContext('2d');
        if (!dstCtx) {
          resolve(dataUrl);
          return;
        }

        const dstImgData = dstCtx.createImageData(dstW, dstH);
        const dstD = dstImgData.data;

        // 3x3 Homography Matrix mapping destination [0, dstW] x [0, dstH] to [p0, p1, p2, p3]
        const H = this.getPerspectiveTransformMatrix(
          [p0, p1, p2, p3],
          dstW,
          dstH,
        );

        const srcW = img.width;
        const srcH = img.height;
        const srcW4 = srcW << 2;
        const srcMaxX = srcW - 2;
        const srcMaxY = srcH - 2;

        const h0 = H[0],
          h1 = H[1],
          h2 = H[2];
        const h3 = H[3],
          h4 = H[4],
          h5 = H[5];
        const h6 = H[6],
          h7 = H[7],
          h8 = H[8];

        let dstIdx = 0;
        for (let y = 0; y < dstH; y++) {
          const h1y_h2 = h1 * y + h2;
          const h4y_h5 = h4 * y + h5;
          const h7y_h8 = h7 * y + h8;

          for (let x = 0; x < dstW; x++, dstIdx += 4) {
            const den = h6 * x + h7y_h8;
            const invDen = 1.0 / den;
            const sx = (h0 * x + h1y_h2) * invDen;
            const sy = (h3 * x + h4y_h5) * invDen;

            const x0 = sx | 0;
            const y0 = sy | 0;

            if (x0 >= 0 && x0 <= srcMaxX && y0 >= 0 && y0 <= srcMaxY) {
              const fx = sx - x0;
              const fy = sy - y0;
              const w00 = (1.0 - fx) * (1.0 - fy);
              const w10 = fx * (1.0 - fy);
              const w01 = (1.0 - fx) * fy;
              const w11 = fx * fy;

              const i00 = (y0 * srcW + x0) << 2;
              const i10 = i00 + 4;
              const i01 = i00 + srcW4;
              const i11 = i01 + 4;

              dstD[dstIdx] =
                srcD[i00] * w00 +
                srcD[i10] * w10 +
                srcD[i01] * w01 +
                srcD[i11] * w11;
              dstD[dstIdx + 1] =
                srcD[i00 + 1] * w00 +
                srcD[i10 + 1] * w10 +
                srcD[i01 + 1] * w01 +
                srcD[i11 + 1] * w11;
              dstD[dstIdx + 2] =
                srcD[i00 + 2] * w00 +
                srcD[i10 + 2] * w10 +
                srcD[i01 + 2] * w01 +
                srcD[i11 + 2] * w11;
              dstD[dstIdx + 3] = 255;
            } else {
              const cx0 = Math.max(0, Math.min(srcW - 1, x0));
              const cx1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
              const cy0 = Math.max(0, Math.min(srcH - 1, y0));
              const cy1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
              const fx = Math.max(0, Math.min(1, sx - x0));
              const fy = Math.max(0, Math.min(1, sy - y0));

              const i00 = (cy0 * srcW + cx0) << 2;
              const i10 = (cy0 * srcW + cx1) << 2;
              const i01 = (cy1 * srcW + cx0) << 2;
              const i11 = (cy1 * srcW + cx1) << 2;

              const w00 = (1.0 - fx) * (1.0 - fy);
              const w10 = fx * (1.0 - fy);
              const w01 = (1.0 - fx) * fy;
              const w11 = fx * fy;

              dstD[dstIdx] =
                srcD[i00] * w00 +
                srcD[i10] * w10 +
                srcD[i01] * w01 +
                srcD[i11] * w11;
              dstD[dstIdx + 1] =
                srcD[i00 + 1] * w00 +
                srcD[i10 + 1] * w10 +
                srcD[i01 + 1] * w01 +
                srcD[i11 + 1] * w11;
              dstD[dstIdx + 2] =
                srcD[i00 + 2] * w00 +
                srcD[i10 + 2] * w10 +
                srcD[i01 + 2] * w01 +
                srcD[i11 + 2] * w11;
              dstD[dstIdx + 3] = 255;
            }
          }
        }

        dstCtx.putImageData(dstImgData, 0, 0);
        resolve(dstCanvas.toDataURL('image/jpeg', 0.95));
      };
      img.src = dataUrl;
    });
  }

  private getPerspectiveTransformMatrix(
    srcQuad: Point2D[],
    dstW: number,
    dstH: number,
  ): number[] {
    const [p0, p1, p2, p3] = srcQuad;
    const x0 = p0.x,
      y0 = p0.y;
    const x1 = p1.x,
      y1 = p1.y;
    const x2 = p2.x,
      y2 = p2.y;
    const x3 = p3.x,
      y3 = p3.y;

    const dx1 = x1 - x2,
      dy1 = y1 - y2;
    const dx2 = x3 - x2,
      dy2 = y3 - y2;
    const sx = x0 - x1 + x2 - x3;
    const sy = y0 - y1 + y2 - y3;

    if (Math.abs(sx) < 1e-5 && Math.abs(sy) < 1e-5) {
      return [
        (x1 - x0) / dstW,
        (x3 - x0) / dstH,
        x0,
        (y1 - y0) / dstW,
        (y3 - y0) / dstH,
        y0,
        0,
        0,
        1,
      ];
    } else {
      const det = dx1 * dy2 - dx2 * dy1;
      const g = (sx * dy2 - sy * dx2) / det;
      const h = (dx1 * sy - dy1 * sx) / det;
      const a = (x1 - x0 + g * x1) / dstW;
      const b = (x3 - x0 + h * x3) / dstH;
      const c = x0;
      const d = (y1 - y0 + g * y1) / dstW;
      const e = (y3 - y0 + h * y3) / dstH;
      const f = y0;
      return [a, b, c, d, e, f, g / dstW, h / dstH, 1];
    }
  }

  // --- Image Rendering with Fine Straightening & Filters ---
  private renderProcessedImage(
    dataUrl: string,
    rotation: number,
    straightenAngle: number,
    flipH: boolean,
    filter: FilterType,
  ): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const totalAngle = (rotation + straightenAngle) % 360;
        const rad = (totalAngle * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(
          1,
          Math.round(img.width * cos + img.height * sin),
        );
        canvas.height = Math.max(
          1,
          Math.round(img.width * sin + img.height * cos),
        );

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }

        // Clean white background for rotated margins
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(rad);
        if (flipH) {
          ctx.scale(-1, 1);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        ctx.restore();

        if (filter === 'original') {
          resolve(canvas.toDataURL('image/jpeg', 0.88));
          return;
        }

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;

        switch (filter) {
          case 'magic':
            this.applyMagicPro(d, canvas.width, canvas.height);
            break;
          case 'enhance':
            this.applyEnhance(d, canvas.width, canvas.height);
            break;
          case 'lighten':
            this.applyLighten(d, canvas.width, canvas.height);
            break;
          case 'noShadow':
            this.applyNoShadow(d, canvas.width, canvas.height);
            break;
          case 'bw':
            this.applyBw(d, canvas.width, canvas.height);
            break;
        }

        ctx.putImageData(imgData, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.src = dataUrl;
    });
  }

  // --- Auto-Skew Detection Algorithm (Projection Profile Variance) ---
  private detectSkewAngle(dataUrl: string): Promise<number> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Downsample to max 300px for instant analysis
        const scale = Math.min(1, 300 / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(0);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h).data;

        const lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          lum[i] =
            0.299 * imgData[i * 4] +
            0.587 * imgData[i * 4 + 1] +
            0.114 * imgData[i * 4 + 2];
        }

        const yStart = Math.floor(h * 0.15);
        const yEnd = Math.floor(h * 0.85);
        const xStart = Math.floor(w * 0.12);
        const xEnd = Math.floor(w * 0.88);
        const sampleW = xEnd - xStart;
        const sampleH = yEnd - yStart;
        const cx = (xStart + xEnd) / 2;
        const cy = (yStart + yEnd) / 2;

        let bestAngle = 0;
        let maxVariance = -1;

        for (let deg = -6; deg <= 6; deg += 0.25) {
          const rad = (deg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const rowSums = new Float32Array(sampleH);

          for (let sy = 0; sy < sampleH; sy++) {
            const y = yStart + sy;
            let darkCount = 0;
            for (let sx = 0; sx < sampleW; sx += 2) {
              const x = xStart + sx;
              const rx = Math.round(cx + (x - cx) * cos - (y - cy) * sin);
              const ry = Math.round(cy + (x - cx) * sin + (y - cy) * cos);
              if (rx >= 0 && rx < w && ry >= 0 && ry < h) {
                if (lum[ry * w + rx] < 155) darkCount++;
              }
            }
            rowSums[sy] = darkCount;
          }

          let sum = 0;
          for (let s = 0; s < sampleH; s++) sum += rowSums[s];
          const mean = sum / sampleH;
          let variance = 0;
          for (let s = 0; s < sampleH; s++) {
            const diff = rowSums[s] - mean;
            variance += diff * diff;
          }

          if (variance > maxVariance) {
            maxVariance = variance;
            bestAngle = deg;
          }
        }
        resolve(Math.round(bestAngle * 10) / 10);
      };
      img.src = dataUrl;
    });
  }

  // --- Signature CamScanner "Magic Pro" Algorithm ---
  private applyMagicPro(d: Uint8ClampedArray, width: number, height: number) {
    const blockSize = Math.max(
      16,
      Math.min(36, Math.floor(Math.min(width, height) / 24)),
    );
    const gw = Math.ceil(width / blockSize);
    const gh = Math.ceil(height / blockSize);

    const bgGridR = new Float32Array(gw * gh);
    const bgGridG = new Float32Array(gw * gh);
    const bgGridB = new Float32Array(gw * gh);

    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const sx = gx * blockSize;
        const sy = gy * blockSize;
        const ex = Math.min(width, sx + blockSize);
        const ey = Math.min(height, sy + blockSize);

        let maxLum = 0;
        let pr = 240,
          pg = 235,
          pb = 215;

        for (let y = sy; y < ey; y += 2) {
          const row = y * width;
          for (let x = sx; x < ex; x += 2) {
            const idx = (row + x) * 4;
            const r = d[idx],
              g = d[idx + 1],
              b = d[idx + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > maxLum) {
              maxLum = lum;
              pr = r;
              pg = g;
              pb = b;
            }
          }
        }

        const gIdx = gy * gw + gx;
        bgGridR[gIdx] = Math.max(120, pr);
        bgGridG[gIdx] = Math.max(120, pg);
        bgGridB[gIdx] = Math.max(100, pb);
      }
    }

    const smoothR = this.blurGrid(bgGridR, gw, gh);
    const smoothG = this.blurGrid(bgGridG, gw, gh);
    const smoothB = this.blurGrid(bgGridB, gw, gh);

    for (let y = 0; y < height; y++) {
      const gy = y / blockSize - 0.5;
      const g0y = Math.max(0, Math.min(gh - 1, Math.floor(gy)));
      const g1y = Math.max(0, Math.min(gh - 1, g0y + 1));
      const fy = Math.max(0, Math.min(1, gy - g0y));
      const rowOffset = y * width;

      for (let x = 0; x < width; x++) {
        const gx = x / blockSize - 0.5;
        const g0x = Math.max(0, Math.min(gw - 1, Math.floor(gx)));
        const g1x = Math.max(0, Math.min(gw - 1, g0x + 1));
        const fx = Math.max(0, Math.min(1, gx - g0x));

        const bgR = this.bilerp(smoothR, g0x, g1x, g0y, g1y, fx, fy, gw);
        const bgG = this.bilerp(smoothG, g0x, g1x, g0y, g1y, fx, fy, gw);
        const bgB = this.bilerp(smoothB, g0x, g1x, g0y, g1y, fx, fy, gw);

        const i = (rowOffset + x) * 4;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];

        const normR = r / bgR;
        const normG = g / bgG;
        const normB = b / bgB;
        const lumNorm = normR * 0.299 + normG * 0.587 + normB * 0.114;

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const chroma = maxC - minC;

        const isBlueInk = b > r + 15 && b > g + 5 && chroma > 18;
        const isRedInk = r > g + 35 && r > b + 35 && chroma > 30;

        let outR: number, outG: number, outB: number;

        if (lumNorm >= 0.82 && !isBlueInk && !isRedInk) {
          outR = 255;
          outG = 255;
          outB = 255;
        } else if (isBlueInk) {
          const darkFactor = Math.pow(Math.min(1, lumNorm / 0.82), 1.2);
          outR = Math.min(255, Math.max(0, Math.round(20 + 70 * darkFactor)));
          outG = Math.min(255, Math.max(0, Math.round(50 + 90 * darkFactor)));
          outB = Math.min(255, Math.max(0, Math.round(140 + 115 * darkFactor)));
        } else if (isRedInk) {
          const darkFactor = Math.pow(Math.min(1, lumNorm / 0.82), 1.1);
          outR = Math.min(255, Math.max(0, Math.round(180 + 75 * darkFactor)));
          outG = Math.min(255, Math.max(0, Math.round(15 + 40 * darkFactor)));
          outB = Math.min(255, Math.max(0, Math.round(15 + 40 * darkFactor)));
        } else {
          const norm = Math.max(0, lumNorm / 0.82);
          const curve = Math.pow(norm, 1.7);
          const ink = Math.min(255, Math.max(0, Math.round(curve * 220)));
          outR = ink;
          outG = ink;
          outB = ink;
        }

        d[i] = outR;
        d[i + 1] = outG;
        d[i + 2] = outB;
      }
    }
  }

  private blurGrid(grid: Float32Array, gw: number, gh: number): Float32Array {
    const out = new Float32Array(grid.length);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sum = 0,
          cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = gy + dy,
              nx = gx + dx;
            if (ny >= 0 && ny < gh && nx >= 0 && nx < gw) {
              sum += grid[ny * gw + nx];
              cnt++;
            }
          }
        }
        out[gy * gw + gx] = sum / cnt;
      }
    }
    return out;
  }

  private bilerp(
    g: Float32Array,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    fx: number,
    fy: number,
    gw: number,
  ): number {
    const top = g[y0 * gw + x0] * (1 - fx) + g[y0 * gw + x1] * fx;
    const bot = g[y1 * gw + x0] * (1 - fx) + g[y1 * gw + x1] * fx;
    return top * (1 - fy) + bot * fy;
  }

  private applyEnhance(d: Uint8ClampedArray, width: number, height: number) {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 210) {
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      } else {
        d[i] = Math.min(255, Math.max(0, Math.round(r * 1.15)));
        d[i + 1] = Math.min(255, Math.max(0, Math.round(g * 1.15)));
        d[i + 2] = Math.min(255, Math.max(0, Math.round(b * 1.15)));
      }
    }
  }

  private applyLighten(d: Uint8ClampedArray, width: number, height: number) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, Math.round(d[i] * 1.25 + 20));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] * 1.25 + 20));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] * 1.25 + 20));
    }
  }

  private applyNoShadow(d: Uint8ClampedArray, width: number, height: number) {
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 185) {
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      } else {
        const factor = lum / 185;
        d[i] = Math.min(255, Math.round(d[i] * factor));
        d[i + 1] = Math.min(255, Math.round(d[i + 1] * factor));
        d[i + 2] = Math.min(255, Math.round(d[i + 2] * factor));
      }
    }
  }

  private applyBw(d: Uint8ClampedArray, width: number, height: number) {
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const val = lum > 138 ? 255 : 0;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
    }
  }

  // --- Helper Methods ---
  private optimizeUploadedImage(file: File): Promise<string> {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const MAX_DIM = 2048;
        const w = img.width;
        const h = img.height;

        // If already within bounds and under 2MB, fast path via high-res canvas
        if (w <= MAX_DIM && h <= MAX_DIM && file.size < 2 * 1024 * 1024) {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', 0.92));
            return;
          }
        }

        // Downscale oversized camera photos (e.g. 4032x3024) to max 2048px (standard print-quality 300 DPI)
        const scale = Math.min(1, MAX_DIM / Math.max(w, h));
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.readFileAsDataUrl(file).then(resolve);
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, outW, outH);
        resolve(canvas.toDataURL('image/jpeg', 0.92));
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        this.readFileAsDataUrl(file).then(resolve);
      };

      img.src = objectUrl;
    });
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(file);
    });
  }

  private readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(blob);
    });
  }

  private getImageDimensions(
    dataUrl: string,
  ): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.src = dataUrl;
    });
  }

  // --- Computer Vision Document Edge Detection Algorithm ---
  private detectDocumentCorners(dataUrl: string): Promise<QuadCorners> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Downsample for instant < 20ms analysis
        const targetW = 320;
        const scale = targetW / img.width;
        const w = targetW;
        const h = Math.max(10, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({
            tl: { x: 3, y: 3 },
            tr: { x: 97, y: 3 },
            br: { x: 97, y: 97 },
            bl: { x: 3, y: 97 },
          });
          return;
        }

        ctx.drawImage(img, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h).data;

        // 1. Grayscale & Luminance Map
        const lum = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const idx = i << 2;
          lum[i] =
            0.299 * imgData[idx] +
            0.587 * imgData[idx + 1] +
            0.114 * imgData[idx + 2];
        }

        // 2. Background Reference Luminance from outer 5% border
        let bgSum = 0;
        let bgCount = 0;
        const marginX = Math.max(2, Math.floor(w * 0.05));
        const marginY = Math.max(2, Math.floor(h * 0.05));

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (
              x < marginX ||
              x >= w - marginX ||
              y < marginY ||
              y >= h - marginY
            ) {
              bgSum += lum[y * w + x];
              bgCount++;
            }
          }
        }
        const bgLum = bgCount > 0 ? bgSum / bgCount : 128;

        // 3. Compute 3x3 Sobel Gradient Magnitude
        const grad = new Float32Array(w * h);
        let maxGrad = 1;
        for (let y = 1; y < h - 1; y++) {
          const row = y * w;
          for (let x = 1; x < w - 1; x++) {
            const gx =
              lum[row - w + x + 1] +
              2 * lum[row + x + 1] +
              lum[row + w + x + 1] -
              (lum[row - w + x - 1] +
                2 * lum[row + x - 1] +
                lum[row + w + x - 1]);
            const gy =
              lum[row + w + x - 1] +
              2 * lum[row + w + x] +
              lum[row + w + x + 1] -
              (lum[row - w + x - 1] +
                2 * lum[row - w + x] +
                lum[row - w + x + 1]);
            const gVal = Math.sqrt(gx * gx + gy * gy);
            grad[row + x] = gVal;
            if (gVal > maxGrad) maxGrad = gVal;
          }
        }

        const edgeThresh = Math.max(22, maxGrad * 0.16);
        const contrastDelta = Math.max(16, Math.abs(160 - bgLum) * 0.22);
        const cx = w / 2;
        const cy = h / 2;

        // 4. Ray-cast inward from corners to find paper boundary
        const findCorner = (startX: number, startY: number): Point2D => {
          const rayRatios = [0.25, 0.38, 0.5, 0.62, 0.75];
          const hits: Point2D[] = [];

          for (const ratio of rayRatios) {
            const targetX = cx + (startX === 0 ? -1 : 1) * (cx * (1 - ratio));
            const targetY = cy + (startY === 0 ? -1 : 1) * (cy * ratio);

            const dx = targetX - startX;
            const dy = targetY - startY;
            const dist = Math.hypot(dx, dy);
            const steps = Math.floor(dist);
            const stepX = dx / steps;
            const stepY = dy / steps;

            let hitX = startX;
            let hitY = startY;
            let found = false;

            for (let s = Math.floor(steps * 0.02); s < steps * 0.85; s++) {
              const px = Math.round(startX + s * stepX);
              const py = Math.round(startY + s * stepY);
              if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue;

              const idx = py * w + px;
              const gVal = grad[idx];
              const lumDiff = Math.abs(lum[idx] - bgLum);

              if (gVal > edgeThresh && lumDiff > contrastDelta) {
                hitX = px;
                hitY = py;
                found = true;
                break;
              }
            }

            if (found) {
              hits.push({
                x: Math.round((hitX / w) * 100 * 10) / 10,
                y: Math.round((hitY / h) * 100 * 10) / 10,
              });
            }
          }

          if (hits.length === 0) {
            return {
              x: startX === 0 ? 3 : 97,
              y: startY === 0 ? 3 : 97,
            };
          }

          hits.sort((a, b) => {
            const da = Math.hypot(
              a.x - (startX === 0 ? 0 : 100),
              a.y - (startY === 0 ? 0 : 100),
            );
            const db = Math.hypot(
              b.x - (startX === 0 ? 0 : 100),
              b.y - (startY === 0 ? 0 : 100),
            );
            return da - db;
          });

          return hits[Math.floor(hits.length / 2)];
        };

        const tl = findCorner(0, 0);
        const tr = findCorner(w - 1, 0);
        const br = findCorner(w - 1, h - 1);
        const bl = findCorner(0, h - 1);

        const validX = tl.x < tr.x - 15 && bl.x < br.x - 15;
        const validY = tl.y < bl.y - 15 && tr.y < br.y - 15;

        if (validX && validY) {
          resolve({
            tl: {
              x: Math.max(1, Math.min(35, tl.x)),
              y: Math.max(1, Math.min(35, tl.y)),
            },
            tr: {
              x: Math.max(65, Math.min(99, tr.x)),
              y: Math.max(1, Math.min(35, tr.y)),
            },
            br: {
              x: Math.max(65, Math.min(99, br.x)),
              y: Math.max(65, Math.min(99, br.y)),
            },
            bl: {
              x: Math.max(1, Math.min(35, bl.x)),
              y: Math.max(65, Math.min(99, bl.y)),
            },
          });
        } else {
          resolve({
            tl: { x: 3, y: 3 },
            tr: { x: 97, y: 3 },
            br: { x: 97, y: 97 },
            bl: { x: 3, y: 97 },
          });
        }
      };

      img.onerror = () => {
        resolve({
          tl: { x: 3, y: 3 },
          tr: { x: 97, y: 3 },
          br: { x: 97, y: 97 },
          bl: { x: 3, y: 97 },
        });
      };

      img.src = dataUrl;
    });
  }
}
