import { Injectable } from '@angular/core';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { environment } from '../../environments/environment';
import { APInvoiceJSON } from '../home/home.page';

@Injectable({
  providedIn: 'root'
})
export class GeminiInvoiceService {
  public getApiKey(): string {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('GEMINI_API_KEY') || localStorage.getItem('gemini_api_key');
      if (stored && stored.trim().length > 0) return stored.trim();
    }
    return (environment.geminiApiKey || '').trim();
  }

  public setApiKey(key: string): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem('GEMINI_API_KEY', key.trim());
    }
  }

  private getClient(): GoogleGenAI {
    const key = this.getApiKey();
    if (!key) {
      throw new Error('Gemini API key is not configured.');
    }
    return new GoogleGenAI({ apiKey: key });
  }

  async extractInvoiceFromImageOrPdf(fileOrDataUrl: File | string): Promise<APInvoiceJSON> {
    let base64Data: string;
    let mimeType = 'image/jpeg';

    if (typeof fileOrDataUrl === 'string') {
      // Handle data URL string (e.g., from canvas or image preview)
      const arr = fileOrDataUrl.split(',');
      const mimeMatch = arr[0].match(/:(.*?);/);
      if (mimeMatch) mimeType = mimeMatch[1];
      base64Data = arr[1];
    } else {
      // Handle File object
      mimeType = fileOrDataUrl.type || 'image/jpeg';
      base64Data = await this.fileToBase64(fileOrDataUrl);
    }

    // Define strict schema matching your APInvoiceJSON interface
    const invoiceSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        documentType: { type: Type.STRING, enum: ['AP_INVOICE'] },
        currency: { type: Type.STRING, description: "e.g. USD, KHR, GBP, EUR" },
        vendor: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: "Vendor, supplier, or seller company name" },
            phone: { type: Type.STRING },
            taxId: { type: Type.STRING },
            street: { type: Type.STRING }
          }
        },
        billTo: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: "Billed to, customer, client, or recipient name" },
            phone: { type: Type.STRING },
            street: { type: Type.STRING }
          }
        },
        invoiceNumber: { type: Type.STRING },
        invoiceDate: { type: Type.STRING, description: "YYYY-MM-DD format" },
        dueDate: { type: Type.STRING, description: "YYYY-MM-DD format" },
        poNumber: { type: Type.STRING, description: "Purchase Order # / PO #" },
        paymentTerms: { type: Type.STRING, description: "e.g. Due on Receipt, Net 30, COD" },
        subtotal: { type: Type.NUMBER },
        taxRate: { type: Type.NUMBER, description: "Tax / VAT percentage (e.g. 5, 10)" },
        taxAmount: { type: Type.NUMBER },
        discountTotal: { type: Type.NUMBER },
        grandTotal: { type: Type.NUMBER },
        bankDetails: {
          type: Type.OBJECT,
          properties: {
            bankName: { type: Type.STRING },
            accountName: { type: Type.STRING },
            accountNumber: { type: Type.STRING }
          }
        },
        notes: { type: Type.STRING },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              itemNo: { type: Type.INTEGER },
              description: { type: Type.STRING },
              quantity: { type: Type.NUMBER },
              unitPrice: { type: Type.NUMBER },
              total: { type: Type.NUMBER }
            },
            required: ["description", "quantity", "unitPrice", "total"]
          }
        },
        rawOcrText: {
          type: Type.STRING,
          description: "Full verbatim line-by-line transcription of the entire document from top to bottom, including all header lines, addresses, dates, table items, totals, and notes, separated with clean line breaks."
        }
      },
      required: ["grandTotal", "invoiceNumber"]
    };

    // Call Gemini 2.5 Flash for high-speed, accurate multilingual (English/Khmer) vision extraction
    const ai = this.getClient();
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        },
        'Accurately extract all AP invoice details into the requested JSON schema. In rawOcrText, provide the full, verbatim line-by-line transcription of all text visible on the document separated with clean line breaks (\n). Preserve Khmer and English characters where present, normalize dates to YYYY-MM-DD, extract Billed To customer name, tax rate %, and ensure math fields match.'
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: invoiceSchema,
        temperature: 0.0
      }
    });

    const parsedJson = JSON.parse(response.text!) as APInvoiceJSON;

    // Fallback compatibility bindings
    parsedJson.documentType = 'AP_INVOICE';
    parsedJson.vendorName = parsedJson.vendor?.name || parsedJson.vendorName || '';
    parsedJson.billedTo = parsedJson.billTo?.name || parsedJson.billedTo || '';

    // Auto-calculate taxRate if missing
    if (parsedJson.subtotal && parsedJson.taxAmount && !parsedJson.taxRate) {
      parsedJson.taxRate = Math.round((parsedJson.taxAmount / parsedJson.subtotal) * 100);
    }

    // Ensure rawOcrText contains real transcribed document lines
    if (!parsedJson.rawOcrText || parsedJson.rawOcrText.trim().length === 0) {
      const lines: string[] = [];
      if (parsedJson.vendor?.name) lines.push(parsedJson.vendor.name);
      if (parsedJson.invoiceNumber) lines.push(`Invoice No: ${parsedJson.invoiceNumber}`);
      if (parsedJson.invoiceDate) lines.push(`Date: ${parsedJson.invoiceDate}`);
      if (parsedJson.dueDate) lines.push(`Due Date: ${parsedJson.dueDate}`);
      if (parsedJson.billTo?.name) lines.push(`Bill To: ${parsedJson.billTo.name}`);
      lines.push('');
      if (parsedJson.items && parsedJson.items.length > 0) {
        lines.push('# Item & Description\tQty\tPrice\tTotal');
        for (const it of parsedJson.items) {
          lines.push(`${it.itemNo || ''} ${it.description}\t${it.quantity}\t${it.unitPrice}\t${it.total}`);
        }
        lines.push('');
      }
      lines.push(`Sub Total: ${parsedJson.currency || 'USD'} ${parsedJson.subtotal}`);
      lines.push(`Tax: ${parsedJson.currency || 'USD'} ${parsedJson.taxAmount}`);
      lines.push(`Grand Total: ${parsedJson.currency || 'USD'} ${parsedJson.grandTotal}`);
      parsedJson.rawOcrText = lines.join('\n');
    }

    return parsedJson;
  }

  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = error => reject(error);
    });
  }
}
