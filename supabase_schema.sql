-- ==============================================================================
-- FieldBi Document Scanner - Supabase Schema
-- Run this script in your Supabase Dashboard: SQL Editor -> New Query -> Run
-- ==============================================================================

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
    pdf_url text -- Optional: link to file stored in Supabase Storage
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

-- 3. Row Level Security Policies (Allow client app with anon key to insert and read)
drop policy if exists "Allow anon read invoices" on public.invoices;
create policy "Allow anon read invoices" on public.invoices
    for select using (true);

drop policy if exists "Allow anon insert invoices" on public.invoices;
create policy "Allow anon insert invoices" on public.invoices
    for insert with check (true);

drop policy if exists "Allow anon update invoices" on public.invoices;
create policy "Allow anon update invoices" on public.invoices
    for update using (true) with check (true);

drop policy if exists "Allow anon delete invoices" on public.invoices;
create policy "Allow anon delete invoices" on public.invoices
    for delete using (true);

drop policy if exists "Allow anon read invoice_line_items" on public.invoice_line_items;
create policy "Allow anon read invoice_line_items" on public.invoice_line_items
    for select using (true);

drop policy if exists "Allow anon insert invoice_line_items" on public.invoice_line_items;
create policy "Allow anon insert invoice_line_items" on public.invoice_line_items
    for insert with check (true);

drop policy if exists "Allow anon update invoice_line_items" on public.invoice_line_items;
create policy "Allow anon update invoice_line_items" on public.invoice_line_items
    for update using (true) with check (true);

drop policy if exists "Allow anon delete invoice_line_items" on public.invoice_line_items;
create policy "Allow anon delete invoice_line_items" on public.invoice_line_items
    for delete using (true);
