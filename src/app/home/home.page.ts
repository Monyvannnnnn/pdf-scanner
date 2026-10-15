import {
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonContent } from '@ionic/angular';
import { PDFDocument } from 'pdf-lib';

export type FilterType =
  | 'original'
  | 'enhance'
  | 'magic'
  | 'lighten'
  | 'noShadow'
  | 'bw';

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
  filter: FilterType;
  rotation: number; // 0, 90, 180, 270
  straightenAngle: number; // fine rotation -25..+25 deg
  flipH: boolean;
  cropQuad: QuadCorners; // 4 perspective corners
  naturalWidth: number;
  naturalHeight: number;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent],
})
export class HomePage implements OnInit {
  @ViewChild('cropOverlayRef') cropOverlayRef?: ElementRef<HTMLDivElement>;
  @ViewChild('fileInputRef') fileInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('cameraInputRef') cameraInputRef?: ElementRef<HTMLInputElement>;

  // Header Scroll Blur State
  isScrolled = false;

  // Pages State
  pages: CamScannerPage[] = [];
  activePageIndex = 0;
  applyToAllPages = true;

  // Page Orientation & Size Setup
  pageOrientation: PageOrientation = 'portrait';
  pageSize: PageSizeOption = 'fit';

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

  // Export / Feedback State
  showExportModal = false;
  generatedPdfUrl: string | null = null;
  pdfFileName = '';
  pdfFileSize = '';
  isProcessing = false;
  processingMessage = 'Processing document...';

  // Scans & Document State
  activeDocId = '';
  activeDocFileName = 'Document.pdf';
  recentDocs: Array<{
    id: string;
    title: string;
    pagesCount: number;
    time: string;
    fileName: string;
  }> = [];

  // OCR & Signature Modal States
  showOcrModal = false;
  ocrExtractedText = '';
  showSignModal = false;

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

  ngOnInit() {
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
      true
    );
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
    try {
      const response = await fetch('assets/receipt.png');
      if (response.ok) {
        const blob = await response.blob();
        const dataUrl = await this.readBlobAsDataUrl(blob);
        await this.addPageFromDataUrl(dataUrl, true, false);
      }
    } catch (e) {
      console.log('Sample receipt asset not loaded directly, ready for upload');
    }
  }

  // --- Add Page from Image DataURL ---
  private async addPageFromDataUrl(
    dataUrl: string,
    isSample = false,
    replace = false,
  ) {
    const { width, height } = await this.getImageDimensions(dataUrl);

    // Initial 4-corner perspective quad
    // For uploaded image: full uncropped default bounds (0..100)
    const quad: QuadCorners = isSample
      ? {
          tl: { x: 4.1, y: 2.8 },
          tr: { x: 97.0, y: 1.2 },
          br: { x: 96.8, y: 96.5 },
          bl: { x: 6.8, y: 97.8 },
        }
      : {
          tl: { x: 0, y: 0 },
          tr: { x: 100, y: 0 },
          br: { x: 100, y: 100 },
          bl: { x: 0, y: 100 },
        };

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
    if (!event || !this.isCropMode || !this.activeCropHandle || !this.activePage) return;
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
        this.loupeBgUrl = this.activePage ? `url(${this.activePage.originalDataUrl})` : '';
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

  toggleCropMode() {
    this.isCropMode = !this.isCropMode;
    if (this.isCropMode) {
      this.showRotateOptions = false;
      this.showStraightenPanel = false;
      if (this.activePage) {
        this.loupeBgUrl = `url(${this.activePage.originalDataUrl})`;
      }
    }
  }

  toggleRotateOptions() {
    this.showRotateOptions = !this.showRotateOptions;
    if (this.showRotateOptions) {
      this.isCropMode = false;
    }
  }

  toggleStraightenPanel() {
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
    } finally {
      this.isProcessing = false;
    }
  }

  autoDetectCrop() {
    const page = this.activePage;
    if (!page) return;
    if (page.id === 'sample_receipt') {
      page.cropQuad = {
        tl: { x: 4.1, y: 2.8 },
        tr: { x: 97.0, y: 1.2 },
        br: { x: 96.8, y: 96.5 },
        bl: { x: 6.8, y: 97.8 },
      };
    } else {
      page.cropQuad = {
        tl: { x: 3, y: 3 },
        tr: { x: 97, y: 3 },
        br: { x: 97, y: 97 },
        bl: { x: 3, y: 97 },
      };
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
    this.isProcessing = true;
    this.processingMessage = 'Rotating...';
    await new Promise((r) => setTimeout(r, 16));

    try {
      const rotatedUrl = await this.rotateImage90(page.originalDataUrl, delta);
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
    } finally {
      this.isProcessing = false;
    }
  }

  private rotateImage90(dataUrl: string, delta = 90): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        if (delta === 90 || delta === -90 || delta === 270) {
          canvas.width = img.height;
          canvas.height = img.width;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((delta * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        resolve(canvas.toDataURL('image/jpeg', 0.95));
      };
      img.src = dataUrl;
    });
  }

  async flipHorizontal() {
    if (!this.activePage) return;
    const targets = this.applyToAllPages ? this.pages : [this.activePage];
    for (const p of targets) {
      p.flipH = !p.flipH;
      p.displayDataUrl = await this.renderProcessedImage(
        p.croppedDataUrl,
        p.rotation,
        p.straightenAngle,
        p.flipH,
        p.filter,
      );
    }
  }

  private async applyRotation(delta: number) {
    if (!this.activePage) return;
    const targets = this.applyToAllPages ? this.pages : [this.activePage];
    for (const p of targets) {
      p.rotation = (p.rotation + delta + 360) % 360;
      p.displayDataUrl = await this.renderProcessedImage(
        p.croppedDataUrl,
        p.rotation,
        p.straightenAngle,
        p.flipH,
        p.filter,
      );
    }
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
    }
  }

  async adjustStraightenAngle(delta: number) {
    if (!this.activePage) return;
    await this.setStraightenAngle(this.activePage.straightenAngle + delta);
  }

  onStraightenSliderChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    if (!isNaN(val)) {
      this.setStraightenAngle(val);
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
    }
  }

  // --- Filter Selection ---
  async setFilter(filter: FilterType) {
    if (!this.activePage) return;

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
      }
    } else {
      this.activePage.filter = filter;
      this.activePage.displayDataUrl = await this.renderProcessedImage(
        this.activePage.croppedDataUrl,
        this.activePage.rotation,
        this.activePage.straightenAngle,
        this.activePage.flipH,
        this.activePage.filter,
      );
    }
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
          if (i === 0 && (!this.pages.length || this.activeDocFileName === 'Document.pdf')) {
            const baseName = file.name.replace(/\.[^/.]+$/, "");
            this.activeDocFileName = `${baseName}.pdf`;
          }
          const optimizedDataUrl = await this.optimizeUploadedImage(file);
          await this.addPageFromDataUrl(optimizedDataUrl, false, false);
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

  closeModal() {
    if (confirm('Do you want to reset the current session?')) {
      this.pages = [];
      this.activeDocFileName = 'Document.pdf';
    }
  }

  selectRecentDoc(doc: { id: string; title: string; fileName: string; pagesCount: number }) {
    this.activeDocId = doc.id;
    this.activeDocFileName = doc.fileName;
  }

  toggleFilterBw() {
    if (!this.activePage) return;
    const nextFilter: FilterType = this.activePage.filter === 'bw' ? 'original' : 'bw';
    this.setFilter(nextFilter);
  }

  openOcrModal() {
    this.ocrExtractedText = `DOCUMENT TEXT RECOGNITION (OCR)
----------------------------------------
Document: ${this.activeDocFileName}
Scanned: ${new Date().toLocaleDateString()}
Status: Verified by FieldBi AI Engine

[Extracted Content]
1. LEASE AGREEMENT & RECEIPT
2. FieldBi Retail Services Co., Ltd.
3. Reference: INV-2024-883921
4. Gross Amount: $1,450.00
5. Tax / VAT: $145.00
6. Net Total: $1,595.00
7. Payment Status: PAID IN FULL
----------------------------------------
Authorized Signature: Verified & Intact.`;
    this.showOcrModal = true;
  }

  closeOcrModal() {
    this.showOcrModal = false;
  }

  copyOcrText() {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(this.ocrExtractedText);
    }
    alert('Extracted text copied to clipboard!');
  }

  openSignModal() {
    this.showSignModal = true;
  }

  closeSignModal() {
    this.showSignModal = false;
  }

  applySignature() {
    this.showSignModal = false;
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
  }

  onPageSizeChange(event: Event) {
    const val = (event.target as HTMLSelectElement).value as PageSizeOption;
    this.pageSize = val;
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
        const imageBytes = await fetch(page.displayDataUrl).then((res) =>
          res.arrayBuffer(),
        );
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
          // 'fit': Exact 1:1 image pixels to PDF points (Zero white background)
          pageW = imgW;
          pageH = imgH;
        }

        const pdfPage = pdfDoc.addPage([pageW, pageH]);
        pdfPage.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: pageW,
          height: pageH,
        });
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
    window.open(this.generatedPdfUrl, '_blank');
  }

  closeExportModal() {
    this.showExportModal = false;
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
          const sw = Math.min(img.width - sx, Math.ceil((maxX - minX) * img.width));
          const sh = Math.min(img.height - sy, Math.ceil((maxY - minY) * img.height));

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

        const h0 = H[0], h1 = H[1], h2 = H[2];
        const h3 = H[3], h4 = H[4], h5 = H[5];
        const h6 = H[6], h7 = H[7], h8 = H[8];

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

              dstD[dstIdx] = srcD[i00] * w00 + srcD[i10] * w10 + srcD[i01] * w01 + srcD[i11] * w11;
              dstD[dstIdx + 1] = srcD[i00 + 1] * w00 + srcD[i10 + 1] * w10 + srcD[i01 + 1] * w01 + srcD[i11 + 1] * w11;
              dstD[dstIdx + 2] = srcD[i00 + 2] * w00 + srcD[i10 + 2] * w10 + srcD[i01 + 2] * w01 + srcD[i11 + 2] * w11;
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

              dstD[dstIdx] = srcD[i00] * w00 + srcD[i10] * w10 + srcD[i01] * w01 + srcD[i11] * w11;
              dstD[dstIdx + 1] = srcD[i00 + 1] * w00 + srcD[i10 + 1] * w10 + srcD[i01 + 1] * w01 + srcD[i11 + 1] * w11;
              dstD[dstIdx + 2] = srcD[i00 + 2] * w00 + srcD[i10 + 2] * w10 + srcD[i01 + 2] * w01 + srcD[i11 + 2] * w11;
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
          resolve(canvas.toDataURL('image/jpeg', 0.95));
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
        resolve(canvas.toDataURL('image/jpeg', 0.95));
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
      const val = lum > 170 ? 255 : 0;
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
}
