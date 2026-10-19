import os
from pathlib import Path
from typing import Optional, Dict, Any, List
from dotenv import load_dotenv
from supabase import create_client, Client
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 1. Load environment variables from .env in project root or current dir
env_path = Path(__file__).resolve().parent.parent / '.env'
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://qvbhlqtfbsnwuzpgrnxg.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

# 2. Initialize Supabase Client
supabase: Optional[Client] = None
if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print(f"[Python Backend] Connected to Supabase at: {SUPABASE_URL}")
    except Exception as e:
        print(f"[Python Backend] Warning: Failed to connect to Supabase: {e}")
else:
    print("[Python Backend] Warning: SUPABASE_URL or SUPABASE_KEY missing in .env")


def save_invoice_to_supabase(data: Dict[str, Any], raw_text: str = "") -> str:
    """
    Saves extracted AP Invoice JSON into Supabase tables 'invoices' and 'invoice_line_items'.
    Supports both standard snake_case and camelCase field formats from OCR.
    """
    if not supabase:
        raise RuntimeError("Supabase client is not configured. Check your SUPABASE_URL and SUPABASE_SECRET_KEY in .env.")

    # Extract vendor name supporting multiple formats
    vendor_obj = data.get("vendor", {})
    vendor_name = (
        data.get("issuer")
        or data.get("vendor_name")
        or data.get("vendorName")
        or (vendor_obj.get("name") if isinstance(vendor_obj, dict) else None)
        or "Unknown Vendor"
    )

    # Extract invoice number
    invoice_number = (
        data.get("invoice_number")
        or data.get("invoiceNumber")
        or "INV-UNKNOWN"
    )

    # Extract date
    issue_date = (
        data.get("issue_date")
        or data.get("date")
        or data.get("invoiceDate")
    )

    # Financial totals
    subtotal = float(data.get("subtotal") or 0)
    tax_amount = float(
        data.get("tax_amount")
        if data.get("tax_amount") is not None
        else (data.get("tax") or data.get("taxAmount") or 0)
    )
    grand_total = float(
        data.get("grand_total")
        if data.get("grand_total") is not None
        else (data.get("amount") or data.get("grandTotal") or (subtotal + tax_amount))
    )

    full_raw_text = raw_text or data.get("raw_text") or data.get("rawOcrText") or ""
    pdf_url = data.get("pdf_url")

    # 1. Insert invoice header
    invoice_payload = {
        "vendor_name": vendor_name,
        "invoice_number": invoice_number,
        "issue_date": issue_date if issue_date else None,
        "currency": data.get("currency", "USD"),
        "subtotal": subtotal,
        "tax_amount": tax_amount,
        "grand_total": grand_total,
        "raw_text": full_raw_text,
        "pdf_url": pdf_url
    }

    invoice_res = supabase.table("invoices").insert(invoice_payload).execute()
    if not invoice_res.data:
        raise RuntimeError(f"Failed to insert invoice: {invoice_res}")

    invoice_id = invoice_res.data[0]["id"]

    # 2. Insert line items if present (supports line_items or items)
    raw_items = data.get("line_items") or data.get("items") or []
    if raw_items:
        items_payload = []
        for item in raw_items:
            items_payload.append({
                "invoice_id": invoice_id,
                "description": item.get("description", "Item"),
                "quantity": float(item.get("qty") or item.get("quantity") or 1),
                "unit_price": float(item.get("unit_price") or item.get("unitPrice") or 0),
                "total": float(item.get("total") or 0)
            })

        supabase.table("invoice_line_items").insert(items_payload).execute()

    return invoice_id


# 3. FastAPI Web Application for Architecture 1
app = FastAPI(title="FieldBi AP Invoice Python Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health_check():
    return {
        "status": "online",
        "service": "FieldBi AP Invoice Python Backend",
        "supabase_connected": supabase is not None
    }

@app.post("/api/ap-invoices")
async def create_ap_invoice(payload: Dict[str, Any] = Body(...)):
    """
    Receives extracted AP Invoice JSON from the Ionic frontend,
    persists into Supabase 'invoices' and 'invoice_line_items', and returns success.
    """
    try:
        raw_text = payload.get("rawOcrText") or payload.get("raw_text") or ""
        invoice_id = save_invoice_to_supabase(payload, raw_text=raw_text)
        return {
            "success": True,
            "invoiceId": invoice_id,
            "message": "AP Invoice saved to Supabase successfully."
        }
    except Exception as e:
        print(f"[API Error] Failed to save invoice: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
