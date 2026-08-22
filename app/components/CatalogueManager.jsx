"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import styles from "./CatalogueManager.module.css";

const EMPTY_WORKSPACE = {
  queue: [],
  liveRows: [],
  shops: [],
  settings: [],
};

const formatMoney = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(Number(value));
};

const formatDate = (value) => {
  if (!value) return "—";
  const datePart = String(value).slice(0, 10);
  return new Intl.DateTimeFormat("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${datePart}T12:00:00`));
};

const throwIfError = ({ data, error }) => {
  if (error) throw error;
  return data;
};

const safeFileName = (name) =>
  String(name || "catalogue-source")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

const catalogueSearchText = (row) =>
  [
    row.shop_name,
    row.product_name,
    row.brand,
    row.size,
    row.category,
    ...(row.search_aliases || []),
    row.product_barcode,
    row.barcode,
    row.shop_sku,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const statusCopy = {
  draft: "Awaiting extraction",
  imported: "Awaiting review",
  reviewing: "Reviewing",
  published: "Published",
  rejected: "Rejected",
};

const verificationCopy = {
  pending: "Villiers comparison pending",
  matched: "Matches Villiers flyer",
  different: "Different from Villiers flyer",
  not_required: "Store-specific source",
};

async function loadCatalogueWorkspace() {
  const [queue, liveRows, shops, settings] = await Promise.all([
    supabase
      .from("catalogue_import_queue")
      .select("*")
      .order("batch_created_at", { ascending: false }),
    supabase
      .from("catalogue_public_rows")
      .select("*")
      .order("shop_name")
      .order("category")
      .order("product_name"),
    supabase
      .from("shops")
      .select("id,name,town,active,catalogue_url,last_catalogue_check")
      .eq("active", true)
      .order("name"),
    supabase
      .from("app_settings")
      .select("key,value,description,updated_at")
      .in("key", [
        "catalogue_public_url",
        "catalogue_json_url",
        "catalogue_text_url",
        "catalogue_last_published_at",
        "catalogue_published_product_count",
        "catalogue_checkout_revalidation_required",
      ]),
  ]);

  return {
    queue: throwIfError(queue) || [],
    liveRows: throwIfError(liveRows) || [],
    shops: throwIfError(shops) || [],
    settings: throwIfError(settings) || [],
  };
}

async function loadBatchItems(batchId) {
  return (
    throwIfError(
      await supabase
        .from("catalogue_staging_items")
        .select("*")
        .eq("batch_id", batchId)
        .order("source_page", { ascending: true, nullsFirst: false })
        .order("product_name"),
    ) || []
  );
}

async function invokeFunction(name, body = {}) {
  const result = await supabase.functions.invoke(name, { body });
  if (result.error) throw result.error;
  if (result.data?.error) throw new Error(result.data.error);
  return result.data;
}

export default function CatalogueManager({ onError, onToast }) {
  const fileInputRef = useRef(null);
  const [workspace, setWorkspace] = useState(EMPTY_WORKSPACE);
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [batchItems, setBatchItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchShopId, setSearchShopId] = useState("all");
  const [manual, setManual] = useState({
    productName: "",
    brand: "",
    size: "",
    category: "Groceries",
    normalPrice: "",
    specialPrice: "",
    specialStarts: "",
    specialEnds: "",
  });

  const loadWorkspace = async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const next = await loadCatalogueWorkspace();
      setWorkspace(next);
      setSelectedBatchId((current) => {
        if (current && next.queue.some((batch) => batch.batch_id === current)) return current;
        return next.queue[0]?.batch_id || null;
      });
    } catch (error) {
      onError(error);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    const pendingSearch = window.sessionStorage.getItem("getit.catalogue.search");
    if (!pendingSearch) return;
    window.sessionStorage.removeItem("getit.catalogue.search");
    setSearchDraft(pendingSearch);
    setSearchQuery(pendingSearch.trim());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedBatchId) {
      setBatchItems([]);
      return undefined;
    }

    setItemsLoading(true);
    loadBatchItems(selectedBatchId)
      .then((items) => {
        if (!cancelled) setBatchItems(items);
      })
      .catch((error) => {
        if (!cancelled) onError(error);
      })
      .finally(() => {
        if (!cancelled) setItemsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedBatchId, onError]);

  useEffect(() => {
    const channelId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const channel = supabase.channel(`getit-catalogue-${channelId}`);
    const tables = [
      "catalogue_sources",
      "catalogue_source_files",
      "catalogue_import_batches",
      "catalogue_staging_items",
      "products",
      "shop_prices",
    ];

    for (const table of tables) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => loadWorkspace({ quiet: true }),
      );
    }

    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const selectedBatch = useMemo(
    () => workspace.queue.find((batch) => batch.batch_id === selectedBatchId) || null,
    [workspace.queue, selectedBatchId],
  );

  const settings = useMemo(
    () => Object.fromEntries(workspace.settings.map((item) => [item.key, item.value])),
    [workspace.settings],
  );

  const liveByShop = useMemo(() => {
    const grouped = new Map();
    for (const row of workspace.liveRows) {
      if (!grouped.has(row.shop_id)) grouped.set(row.shop_id, { name: row.shop_name, rows: [] });
      grouped.get(row.shop_id).rows.push(row);
    }
    return [...grouped.values()];
  }, [workspace.liveRows]);

  const searchResults = useMemo(() => {
    const tokens = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (!tokens.length) return [];

    return workspace.liveRows
      .filter((row) => searchShopId === "all" || row.shop_id === searchShopId)
      .filter((row) => {
        const haystack = catalogueSearchText(row);
        return tokens.every((token) => haystack.includes(token));
      })
      .sort((left, right) => {
        if (Boolean(left.in_stock) !== Boolean(right.in_stock)) return left.in_stock ? -1 : 1;
        const leftPrice = Number(left.effective_price);
        const rightPrice = Number(right.effective_price);
        if (Number.isFinite(leftPrice) && Number.isFinite(rightPrice) && leftPrice !== rightPrice) {
          return leftPrice - rightPrice;
        }
        return String(left.shop_name).localeCompare(String(right.shop_name));
      });
  }, [workspace.liveRows, searchQuery, searchShopId]);

  const pendingRows = workspace.queue.reduce(
    (total, batch) =>
      total + Math.max(
        0,
        Number(batch.raw_item_count || 0) -
          Number(batch.accepted_item_count || 0) -
          Number(batch.rejected_item_count || 0),
      ),
    0,
  );
  const archivedFiles = workspace.queue.reduce(
    (total, batch) => total + Number(batch.archived_file_count || 0),
    0,
  );
  const publicUrl = typeof settings.catalogue_public_url === "string"
    ? settings.catalogue_public_url
    : null;
  const lastPublished = typeof settings.catalogue_last_published_at === "string"
    ? settings.catalogue_last_published_at
    : null;
  const sourceFreshness = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expired = [];
    const expiringSoon = [];

    for (const batch of workspace.queue) {
      if (!batch.valid_to) continue;
      const validUntil = new Date(`${String(batch.valid_to).slice(0, 10)}T12:00:00`);
      validUntil.setHours(0, 0, 0, 0);
      const daysRemaining = Math.round((validUntil.getTime() - today.getTime()) / 86_400_000);
      if (daysRemaining < 0) expired.push(batch);
      else if (daysRemaining <= 1) expiringSoon.push(batch);
    }

    return { expired, expiringSoon };
  }, [workspace.queue]);

  const run = async (task, success) => {
    setBusy(true);
    try {
      const result = await task();
      await loadWorkspace({ quiet: true });
      if (selectedBatchId) setBatchItems(await loadBatchItems(selectedBatchId));
      if (success) onToast(success);
      return result;
    } catch (error) {
      onError(error);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const updateComparison = (status) => {
    if (!selectedBatch) return;
    run(
      async () => {
        const result = await supabase
          .from("catalogue_sources")
          .update({ villiers_comparison_status: status })
          .eq("id", selectedBatch.source_id)
          .select("id")
          .single();
        return throwIfError(result);
      },
      status === "matched"
        ? "Flyer marked as matching Villiers"
        : "Flyer comparison status updated",
    );
  };

  const uploadSource = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedBatch) return;

    await run(async () => {
      const folder = String(selectedBatch.local_copy_path || selectedBatch.source_id)
        .replace(/^\/+|\/+$/g, "");
      const path = `${folder}/${Date.now()}-${safeFileName(file.name)}`;
      const upload = await supabase.storage
        .from("getit-catalogue-sources")
        .upload(path, file, { upsert: false, contentType: file.type || undefined });
      throwIfError(upload);

      const inserted = await supabase
        .from("catalogue_source_files")
        .insert({
          source_id: selectedBatch.source_id,
          original_url: selectedBatch.source_url || null,
          storage_path: path,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          file_size_bytes: file.size,
          extraction_status: "not_started",
        })
        .select("id")
        .single();

      if (inserted.error) {
        await supabase.storage.from("getit-catalogue-sources").remove([path]);
        throw inserted.error;
      }
      return inserted.data;
    }, `${file.name} stored safely in Getit`);
  };

  const reviewItem = (item, status) => run(
    async () => {
      const result = await supabase
        .from("catalogue_staging_items")
        .update({ review_status: status })
        .eq("id", item.id)
        .select("id")
        .single();
      return throwIfError(result);
    },
    status === "accepted" ? "Catalogue item accepted" : "Catalogue item rejected",
  );

  const publishBatch = () => {
    if (!selectedBatch) return;
    run(async () => {
      const promoted = await supabase.rpc("publish_catalogue_batch", {
        p_batch_id: selectedBatch.batch_id,
      });
      throwIfError(promoted);
      return invokeFunction("publish-catalogue", {
        reason: "control_centre_publish",
        batch_id: selectedBatch.batch_id,
      });
    }, "Catalogue batch published and public files refreshed");
  };

  const publishFiles = () => run(
    () => invokeFunction("publish-catalogue", { reason: "manual_control_centre_refresh" }),
    "Public catalogue files refreshed",
  );

  const addManualItem = async (event) => {
    event.preventDefault();
    if (!selectedBatch) return;

    const normalPrice = manual.normalPrice === "" ? null : Number(manual.normalPrice);
    const specialPrice = manual.specialPrice === "" ? null : Number(manual.specialPrice);
    if (!manual.productName.trim()) {
      onError(new Error("Add the product name."));
      return;
    }
    if (normalPrice === null && specialPrice === null) {
      onError(new Error("Add either the normal price or the advertised special price."));
      return;
    }
    if (specialPrice !== null && (!manual.specialStarts || !manual.specialEnds)) {
      onError(new Error("A special price needs a start date and an end date."));
      return;
    }

    const result = await run(
      () => invokeFunction("import-catalogue-batch", {
        source_id: selectedBatch.source_id,
        auto_accept: true,
        publish_now: true,
        batch_notes: "Added manually in the Getit Control Centre",
        items: [{
          product_name: manual.productName.trim(),
          brand: manual.brand.trim() || null,
          size: manual.size.trim() || null,
          category: manual.category.trim() || "Groceries",
          search_aliases: [manual.productName.trim().toLowerCase()],
          normal_price: normalPrice,
          special_price: specialPrice,
          special_starts: specialPrice !== null ? manual.specialStarts : null,
          special_ends: specialPrice !== null ? manual.specialEnds : null,
          review_note: "Added manually in the Getit Control Centre",
        }],
      }),
      "Product added and catalogue republished",
    );

    if (result) {
      setManualOpen(false);
      setManual({
        productName: "",
        brand: "",
        size: "",
        category: "Groceries",
        normalPrice: "",
        specialPrice: "",
        specialStarts: "",
        specialEnds: "",
      });
    }
  };

  const submitPriceSearch = (event) => {
    event.preventDefault();
    setSearchQuery(searchDraft.trim());
  };

  const clearPriceSearch = () => {
    setSearchDraft("");
    setSearchQuery("");
    setSearchShopId("all");
  };

  if (loading) return <div className="app-loading">Opening the catalogue workspace…</div>;

  return (
    <main className={`page-shell ${styles.page}`}>
      <section className={`page-heading ${styles.heading}`}>
        <div>
          <p className="eyebrow">PRODUCTS & PRICES</p>
          <h1>Catalogue</h1>
          <p className="muted">
            Getit stores source files privately, publishes only cleaned product information,
            and checks each price again before payment.
          </p>
        </div>
        <div className={styles.headingActions}>
          {publicUrl && (
            <a className={`ghost-button ${styles.linkButton}`} href={publicUrl} target="_blank" rel="noreferrer">
              Open public catalogue
            </a>
          )}
          <button type="button" className="primary-button" disabled={busy} onClick={publishFiles}>
            {busy ? "Working…" : "Publish catalogue files"}
          </button>
        </div>
      </section>

      <section className={styles.stats}>
        <div><span>Live shop products</span><strong>{workspace.liveRows.length}</strong></div>
        <div><span>Rows awaiting review</span><strong>{pendingRows}</strong></div>
        <div><span>Source files stored</span><strong>{archivedFiles}</strong></div>
        <div><span>Last published</span><strong>{lastPublished ? formatDate(lastPublished) : "Not yet"}</strong></div>
      </section>

      <div className={styles.trustNote}>
        <strong>Flyer rule:</strong> regional flyer specials may be shown while comparison is pending,
        but the final price and stock are confirmed before payment.
      </div>

      {(sourceFreshness.expired.length || sourceFreshness.expiringSoon.length) && (
        <div className={`${styles.freshnessNotice} ${sourceFreshness.expired.length ? styles.freshnessUrgent : ""}`}>
          <strong>Catalogue refresh needed</strong>
          <span>
            {sourceFreshness.expired.length
              ? `${sourceFreshness.expired.length} source${sourceFreshness.expired.length === 1 ? " has" : "s have"} expired. Upload a current flyer before using any listed price.`
              : `${sourceFreshness.expiringSoon.length} source${sourceFreshness.expiringSoon.length === 1 ? " expires" : "s expire"} within one day. Get the next flyer ready now.`}
          </span>
        </div>
      )}

      <section className={`panel ${styles.priceFinder}`}>
        <div className={styles.priceFinderHeading}>
          <div>
            <p className="eyebrow">QUICK PRICE CHECK</p>
            <h2>Find a product in any shop</h2>
            <span>Search by product, brand, size, category or barcode and compare prices across Villiers shops.</span>
          </div>
          {searchQuery && (
            <button type="button" className="small-button" onClick={clearPriceSearch}>
              Clear
            </button>
          )}
        </div>

        <form className={styles.searchForm} onSubmit={submitPriceSearch}>
          <label className={styles.searchField}>
            Product search
            <input
              autoFocus
              type="search"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Example: tomato sauce 700 ml"
            />
          </label>
          <label>
            Shop
            <select value={searchShopId} onChange={(event) => setSearchShopId(event.target.value)}>
              <option value="all">All shops</option>
              {workspace.shops.map((shop) => (
                <option value={shop.id} key={shop.id}>{shop.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-button">Search catalogue</button>
        </form>

        {searchQuery && (
          <div className={styles.searchResults}>
            <div className={styles.searchSummary}>
              <strong>{searchResults.length} {searchResults.length === 1 ? "match" : "matches"}</strong>
              <span>for “{searchQuery}”</span>
            </div>
            {searchResults.length ? (
              <div className={styles.searchGrid}>
                {searchResults.map((row) => (
                  <article key={`search-${row.shop_id}-${row.product_id}`}>
                    <div className={styles.searchProduct}>
                      <span>{row.shop_name}</span>
                      <strong>{[row.brand, row.product_name, row.size].filter(Boolean).join(" ")}</strong>
                      <small>{row.category}</small>
                    </div>
                    <div className={styles.searchPrice}>
                      <strong>{formatMoney(row.effective_price)}</strong>
                      <span>{row.current_special_price != null ? `Special until ${formatDate(row.current_special_ends)}` : "Current normal price"}</span>
                    </div>
                    <div className={styles.searchChecks}>
                      <span className={row.in_stock ? styles.available : styles.unavailable}>
                        {row.in_stock ? "Listed available" : "Listed unavailable"}
                      </span>
                      <small>
                        {row.local_verification_status === "verified"
                          ? "Villiers verified"
                          : "Check shelf price before payment"}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.searchEmpty}>
                <strong>No catalogue price found.</strong>
                <span>Keep the item as PRICE PENDING and check the current flyer or shelf price. The order can still continue.</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className={styles.layout}>
        <aside className={`panel ${styles.sourceList}`}>
          <div className={styles.panelHeading}>
            <div><p className="eyebrow">SOURCES</p><h2>Flyers & lists</h2></div>
            <span>{workspace.queue.length}</span>
          </div>

          {workspace.queue.length ? workspace.queue.map((batch) => (
            <button
              type="button"
              key={batch.batch_id}
              className={`${styles.sourceCard} ${selectedBatchId === batch.batch_id ? styles.active : ""}`}
              onClick={() => setSelectedBatchId(batch.batch_id)}
            >
              <div>
                <strong>{batch.shop_name}</strong>
                <span>{batch.source_title}</span>
              </div>
              <small>{formatDate(batch.valid_from)} – {formatDate(batch.valid_to)}</small>
              <div className={styles.cardMeta}>
                <span className={styles.status}>{statusCopy[batch.batch_status] || batch.batch_status}</span>
                <span>{batch.raw_item_count || 0} items</span>
                <span>{batch.archived_file_count || 0} files</span>
              </div>
            </button>
          )) : <p className="empty-message">No catalogue sources have been registered.</p>}
        </aside>

        <section className={`panel ${styles.detail}`}>
          {!selectedBatch ? (
            <div className="help-empty-state">
              <strong>Select a catalogue source</strong>
              <span>The flyer, review queue and stored files will appear here.</span>
            </div>
          ) : (
            <>
              <header className={styles.detailHeader}>
                <div>
                  <p className="eyebrow">{selectedBatch.shop_name}</p>
                  <h2>{selectedBatch.source_title}</h2>
                  <span>{selectedBatch.region || "No region recorded"}</span>
                </div>
                <span className={`${styles.verification} ${styles[selectedBatch.villiers_comparison_status] || ""}`}>
                  {verificationCopy[selectedBatch.villiers_comparison_status] || selectedBatch.villiers_comparison_status}
                </span>
              </header>

              <div className={styles.sourceActions}>
                {selectedBatch.source_url && (
                  <a className="small-button link-button" href={selectedBatch.source_url} target="_blank" rel="noreferrer">
                    Open online flyer
                  </a>
                )}
                <button type="button" className="small-button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                  Upload local copy
                </button>
                <input ref={fileInputRef} className={styles.fileInput} type="file" accept="image/*,.pdf,.csv,.xlsx" onChange={uploadSource} />
                <button type="button" className="small-button" disabled={busy} onClick={() => updateComparison("matched")}>Matches Villiers</button>
                <button type="button" className="small-button" disabled={busy} onClick={() => updateComparison("different")}>Different in Villiers</button>
                <button type="button" className="small-button" disabled={busy} onClick={() => setManualOpen((value) => !value)}>
                  {manualOpen ? "Close product form" : "Add one product"}
                </button>
              </div>

              {manualOpen && (
                <form className={styles.manualForm} onSubmit={addManualItem}>
                  <div className={styles.formGrid}>
                    <label>Product name<input value={manual.productName} onChange={(event) => setManual({ ...manual, productName: event.target.value })} /></label>
                    <label>Brand<input value={manual.brand} onChange={(event) => setManual({ ...manual, brand: event.target.value })} /></label>
                    <label>Pack size<input value={manual.size} onChange={(event) => setManual({ ...manual, size: event.target.value })} placeholder="Example: 2 kg" /></label>
                    <label>Category<input value={manual.category} onChange={(event) => setManual({ ...manual, category: event.target.value })} /></label>
                    <label>Normal price<input type="number" min="0" step="0.01" value={manual.normalPrice} onChange={(event) => setManual({ ...manual, normalPrice: event.target.value })} /></label>
                    <label>Special price<input type="number" min="0" step="0.01" value={manual.specialPrice} onChange={(event) => setManual({ ...manual, specialPrice: event.target.value })} /></label>
                    <label>Special starts<input type="date" value={manual.specialStarts} onChange={(event) => setManual({ ...manual, specialStarts: event.target.value })} /></label>
                    <label>Special ends<input type="date" value={manual.specialEnds} onChange={(event) => setManual({ ...manual, specialEnds: event.target.value })} /></label>
                  </div>
                  <button type="submit" className="primary-button compact" disabled={busy}>{busy ? "Adding…" : "Add & publish"}</button>
                </form>
              )}

              <div className={styles.sourceSummary}>
                <div><span>Valid from</span><strong>{formatDate(selectedBatch.valid_from)}</strong></div>
                <div><span>Valid until</span><strong>{formatDate(selectedBatch.valid_to)}</strong></div>
                <div><span>Accepted</span><strong>{selectedBatch.accepted_item_count || 0}</strong></div>
                <div><span>Stored files</span><strong>{selectedBatch.archived_file_count || 0}</strong></div>
              </div>

              <section className={styles.reviewSection}>
                <div className={styles.sectionHeading}>
                  <div><p className="eyebrow">IMPORT BATCH</p><h3>Products from this source</h3></div>
                  {selectedBatch.accepted_item_count > 0 && selectedBatch.batch_status !== "published" && (
                    <button type="button" className="primary-button compact" disabled={busy} onClick={publishBatch}>Publish accepted items</button>
                  )}
                </div>

                {itemsLoading ? (
                  <p className="empty-message">Loading products…</p>
                ) : batchItems.length ? (
                  <div className={styles.itemList}>
                    {batchItems.map((item) => (
                      <article className={styles.itemRow} key={item.id}>
                        <div>
                          <strong>{[item.brand, item.product_name, item.size].filter(Boolean).join(" ")}</strong>
                          <span>{item.category} · page {item.source_page || "—"}</span>
                        </div>
                        <div className={styles.itemPrice}>
                          <strong>{formatMoney(item.special_price ?? item.normal_price)}</strong>
                          <span>{item.special_price !== null ? `Special until ${formatDate(item.special_ends)}` : "Normal price"}</span>
                        </div>
                        <span className={styles.reviewStatus}>{item.review_status.replaceAll("_", " ")}</span>
                        {item.review_status === "pending" && (
                          <div className={styles.rowActions}>
                            <button type="button" className="small-button" disabled={busy} onClick={() => reviewItem(item, "rejected")}>Reject</button>
                            <button type="button" className="small-button" disabled={busy} onClick={() => reviewItem(item, "accepted")}>Accept</button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyBatch}>
                    <strong>The source is registered and ready.</strong>
                    <span>The flyer pages still need to be copied and converted into structured product rows. Nothing fictional has been published.</span>
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      </section>

      <section className={`panel ${styles.livePanel}`}>
        <div className={styles.panelHeading}>
          <div><p className="eyebrow">PUBLISHED OUTPUT</p><h2>Live catalogue preview</h2></div>
          <span>{workspace.liveRows.length}</span>
        </div>
        {liveByShop.length ? liveByShop.map((shop) => (
          <div className={styles.liveShop} key={shop.name}>
            <h3>{shop.name}</h3>
            <div className={styles.liveGrid}>
              {shop.rows.map((row) => (
                <article key={`${row.shop_id}-${row.product_id}`}>
                  <div><strong>{[row.brand, row.product_name, row.size].filter(Boolean).join(" ")}</strong><span>{row.category}</span></div>
                  <div><strong>{formatMoney(row.effective_price)}</strong><span>{row.current_special_price !== null ? "Current special" : "Normal price"}</span></div>
                  <span className={styles.verification}>
                    {row.local_verification_status === "verified" ? "Verified" : "Villiers check pending"}
                  </span>
                </article>
              ))}
            </div>
          </div>
        )) : (
          <div className={styles.emptyBatch}>
            <strong>No real catalogue products are live yet.</strong>
            <span>The old mock prices are correctly excluded. The first approved flyer items will appear here.</span>
          </div>
        )}
      </section>
    </main>
  );
}
