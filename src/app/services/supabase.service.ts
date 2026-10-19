import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { APInvoiceJSON } from '../home/home.page';

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  public supabase: SupabaseClient | null = null;

  constructor() {
    this.initClient();
  }

  protected initClient() {
    const url = environment.supabase?.url || '';
    const anonKey = environment.supabase?.anonKey || '';

    if (
      url &&
      anonKey &&
      !url.includes('YOUR_SUPABASE_PROJECT_REF') &&
      !anonKey.includes('YOUR_SUPABASE_ANON_KEY')
    ) {
      try {
        this.supabase = createClient(url, anonKey);
        console.log('[SupabaseService] Initialized with Supabase URL:', url);
      } catch (err) {
        console.warn('[SupabaseService] Initialization failed:', err);
        this.supabase = null;
      }
    } else {
      this.supabase = null;
    }
  }

  /**
   * Checks if valid Supabase credentials have been configured
   */
  isConfigured(): boolean {
    return this.supabase !== null;
  }

  /**
   * Get raw Supabase client
   */
  getClient(): SupabaseClient | null {
    if (!this.supabase) {
      this.initClient();
    }
    return this.supabase;
  }

  /**
   * Saves extracted AP Invoice JSON directly to Supabase tables 'invoices' and 'invoice_line_items',
   * with optional storage file/image upload.
   *
   * @param extractedJson Extracted invoice JSON object (supports camelCase and snake_case keys)
   * @param rawText Full raw OCR text
   * @param file Optional File or Blob (original image or PDF) to upload to Supabase Storage
   */
  async saveExtractedInvoice(
    extractedJson: any,
    rawText: string = '',
    file?: File | Blob,
  ): Promise<{ success: boolean; invoiceId?: string; data?: any; error?: string }> {
    const client = this.getClient();
    if (!client) {
      return {
        success: false,
        error:
          'Supabase is not configured yet. Please add your Supabase URL & Anon Key in src/environments/environment.ts',
      };
    }

    let pdfUrl: string | null = null;

    // Optional: Upload original PDF/Image to Supabase Storage bucket 'invoices' first
    if (file) {
      try {
        const rawFileName = file instanceof File ? file.name : `invoice_${Date.now()}.jpg`;
        const fileName = `${Date.now()}_${rawFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const { error: uploadError } = await client.storage
          .from('invoices')
          .upload(fileName, file, {
            upsert: true,
            contentType: file.type || 'image/jpeg',
          });

        if (!uploadError) {
          const { data: publicUrlData } = client.storage
            .from('invoices')
            .getPublicUrl(fileName);
          pdfUrl = publicUrlData?.publicUrl || null;
        } else {
          console.warn(
            '[SupabaseService] Supabase storage upload notice (create "invoices" bucket in Supabase Storage if you wish to store files):',
            uploadError.message,
          );
        }
      } catch (uploadErr) {
        console.warn('[SupabaseService] Storage upload skipped:', uploadErr);
      }
    }

    try {
      // 1. Prepare fields supporting both snake_case and camelCase APInvoiceJSON
      const vendorName =
        extractedJson.vendor_name ||
        extractedJson.vendor?.name ||
        extractedJson.vendorName ||
        extractedJson.issuer ||
        'Unknown Vendor';

      const invoiceNumber =
        extractedJson.invoice_number ||
        extractedJson.invoiceNumber ||
        `INV-${Date.now().toString().slice(-6)}`;

      const issueDate =
        extractedJson.issue_date ||
        extractedJson.invoiceDate ||
        extractedJson.date ||
        null;

      const currency = extractedJson.currency || 'USD';

      const subtotal = extractedJson.subtotal
        ? parseFloat(String(extractedJson.subtotal).replace(/,/g, ''))
        : 0;

      const taxAmount =
        extractedJson.tax_amount !== undefined
          ? parseFloat(String(extractedJson.tax_amount).replace(/,/g, ''))
          : extractedJson.taxAmount !== undefined
            ? parseFloat(String(extractedJson.taxAmount).replace(/,/g, ''))
            : extractedJson.tax !== undefined
              ? parseFloat(String(extractedJson.tax).replace(/,/g, ''))
              : 0;

      const grandTotal =
        extractedJson.grand_total !== undefined
          ? parseFloat(String(extractedJson.grand_total).replace(/,/g, ''))
          : extractedJson.grandTotal !== undefined
            ? parseFloat(String(extractedJson.grandTotal).replace(/,/g, ''))
            : extractedJson.amount !== undefined
              ? parseFloat(String(extractedJson.amount).replace(/,/g, ''))
              : subtotal + taxAmount;

      const fullRawText =
        rawText || extractedJson.rawOcrText || extractedJson.raw_text || '';

      // 2. Insert into 'invoices' table
      const { data: invoiceRecord, error: invoiceError } = await client
        .from('invoices')
        .insert({
          vendor_name: vendorName,
          invoice_number: invoiceNumber,
          issue_date: issueDate,
          currency,
          subtotal,
          tax_amount: taxAmount,
          grand_total: grandTotal,
          raw_text: fullRawText,
          pdf_url: pdfUrl,
        })
        .select()
        .single();

      if (invoiceError) {
        // Fallback: If table 'invoices' does not exist yet in project, try legacy 'ap_invoices'
        if (
          invoiceError.code === '42P01' ||
          invoiceError.code === 'PGRST205' ||
          invoiceError.message?.includes('schema cache')
        ) {
          console.warn('[SupabaseService] Table "invoices" not found, falling back to "ap_invoices"...');
          return this.insertLegacyApInvoice(extractedJson);
        }
        console.error('Error saving invoice header:', invoiceError);
        return { success: false, error: invoiceError.message };
      }

      const invoiceId = invoiceRecord.id;

      // 3. Insert Line Items if any exist (supports line_items or items)
      const rawItems = extractedJson.line_items || extractedJson.items || [];
      if (rawItems && rawItems.length > 0) {
        const lineItemsToInsert = rawItems.map((item: any) => ({
          invoice_id: invoiceId,
          description: item.description || '',
          quantity: item.qty || item.quantity || 1,
          unit_price:
            item.unit_price !== undefined
              ? parseFloat(String(item.unit_price).replace(/,/g, ''))
              : item.unitPrice || 0,
          total:
            item.total !== undefined
              ? parseFloat(String(item.total).replace(/,/g, ''))
              : 0,
        }));

        const { error: lineError } = await client
          .from('invoice_line_items')
          .insert(lineItemsToInsert);

        if (lineError) {
          console.error('Error saving line items:', lineError);
        }
      }

      console.log('[SupabaseService] Invoice saved successfully:', invoiceRecord);
      return { success: true, invoiceId, data: invoiceRecord };
    } catch (err: any) {
      console.error('[SupabaseService] Unexpected save error:', err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Insert an AP Invoice into the Supabase database (delegates to saveExtractedInvoice)
   */
  async insertInvoice(
    invoice: APInvoiceJSON,
    pdfUrl?: string,
    file?: File | Blob,
  ): Promise<{ success: boolean; invoiceId?: string; data?: any; error?: string }> {
    return this.saveExtractedInvoice(invoice, invoice.rawOcrText, file);
  }

  /**
   * Fallback for older projects with unified 'ap_invoices' table
   */
  private async insertLegacyApInvoice(
    invoice: APInvoiceJSON,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const client = this.getClient();
    if (!client) return { success: false, error: 'Supabase client not initialized' };

    try {
      const record = {
        invoice_number: invoice.invoiceNumber,
        vendor_name: invoice.vendor?.name || invoice.vendorName || 'Unknown Vendor',
        invoice_date: invoice.invoiceDate || null,
        due_date: invoice.dueDate || null,
        billed_to: invoice.billTo?.name || invoice.billedTo || null,
        currency: invoice.currency || 'USD',
        subtotal: invoice.subtotal || 0,
        tax_rate: invoice.taxRate || 0,
        tax_amount: invoice.taxAmount || 0,
        grand_total: invoice.grandTotal || 0,
        items: invoice.items || [],
        raw_ocr_text: invoice.rawOcrText || null,
      };

      const { data, error } = await client
        .from('ap_invoices')
        .upsert(record, { onConflict: 'invoice_number' })
        .select()
        .single();

      if (error) {
        return { success: false, error: error.message };
      }
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Fetch all Invoices with linked line items from Supabase
   */
  async getInvoices(): Promise<any[]> {
    const client = this.getClient();
    if (!client) return [];

    try {
      const { data, error } = await client
        .from('invoices')
        .select('*, line_items:invoice_line_items(*)')
        .order('created_at', { ascending: false });

      if (error) {
        // Fallback to legacy ap_invoices
        if (
          error.code === '42P01' ||
          error.code === 'PGRST205' ||
          error.message?.includes('schema cache')
        ) {
          const legacy = await client
            .from('ap_invoices')
            .select('*')
            .order('created_at', { ascending: false });
          return legacy.data || [];
        }
        console.error('[SupabaseService] Fetch error:', error);
        return [];
      }
      return data || [];
    } catch (err) {
      console.error('[SupabaseService] Fetch failed:', err);
      return [];
    }
  }

  /**
   * Delete an AP Invoice by ID or invoice number (cascades to line items)
   */
  async deleteInvoice(idOrNumber: string): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;

    try {
      const { error } = await client
        .from('invoices')
        .delete()
        .or(`id.eq.${idOrNumber},invoice_number.eq.${idOrNumber}`);

      if (
        error &&
        (error.code === '42P01' ||
          error.code === 'PGRST205' ||
          error.message?.includes('schema cache'))
      ) {
        const legacy = await client
          .from('ap_invoices')
          .delete()
          .or(`id.eq.${idOrNumber},invoice_number.eq.${idOrNumber}`);
        return !legacy.error;
      }

      return !error;
    } catch {
      return false;
    }
  }
}

/**
 * Direct alias for InvoiceDatabaseService
 */
@Injectable({
  providedIn: 'root',
})
export class InvoiceDatabaseService extends SupabaseService {}
