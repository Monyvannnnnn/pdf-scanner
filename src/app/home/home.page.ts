import { Component } from '@angular/core';
import { DocumentScanner } from '@capacitor-mlkit/document-scanner';
import { IonButton, IonContent, IonIcon } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { camera } from 'ionicons/icons';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonContent, IonButton, IonIcon],
})
export class HomePage {
  filePath: string = '';
  selectedWebFile: File | null = null;

  constructor() {
    addIcons({ camera });
  }

  // --- MOBILE FLOW: Native Camera Scanner ---
  async startScan() {
    try {
      const result = await DocumentScanner.scanDocument({
        scannerMode: 'FULL',
        resultFormats: 'JPEG_PDF',
        pageLimit: 3,
      });

      const pdfUri =
        result.pdf?.uri ??
        (result.pdf as { fileUri?: string } | undefined)?.fileUri;
      if (pdfUri) {
        this.filePath = pdfUri;
        console.log('Mobile PDF Path:', this.filePath);
      }
    } catch (error) {
      console.error('Scan error or cancelled:', error);
    }
  }

  // --- WEB FLOW: PC File Picker ---
  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.selectedWebFile = file;
      this.filePath = file.name;
      console.log('Web File Selected:', this.selectedWebFile);
    }
  }
}
