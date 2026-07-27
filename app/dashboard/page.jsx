"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DriverBoard from "../components/DriverBoard";
import FocusStrip from "../components/FocusStrip";
import OperationsMap from "../components/OperationsMap";
import PaymentQueue from "../components/PaymentQueue";
import SupportQueue from "../components/SupportQueue";
import Topbar from "../components/Topbar";
import { createControlCentre } from "../../lib/controlCentre";
import { clock, humanizeError } from "../../lib/format";
import { supabase } from "../../lib/supabase";

const EMPTY_DATA = {
  drivers: [],
  orders: [],
  paymentQueue: [],
  orderPins: [],
  shopPins: [],
  openQueries: [],
};

export default function DashboardPage() {
  const router = useRouter();
  const apiRef = useRef(null);
  const toastTimerRef = useRef(null);
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState("operations");
  const [data, setData] = useState(EMPTY_DATA);
  const [connection, setConnection] = useState("CONNECTING");
  const [browserOnline, setBrowserOnline] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [mutation, setMutation] = useState(null);
  const [apiClient, setApiClient] = useState(null);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: result, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(humanizeError(sessionError));
      setSession(result.session);
      setAuthReady(true);
      if (!result.session) router.replace("/login");
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) router.replace("/login");
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
      window.clearTimeout(toastTimerRef.current);
    };
  }, [router]);

  useEffect(() => {
    const updateOnline = () => setBrowserOnline(navigator.onLine);
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    const checkStale = () => {
      setStale(Boolean(lastUpdatedAt && Date.now() - lastUpdatedAt.getTime() > 90_000));
    };
    checkStale();
    const timer = window.setInterval(checkStale, 15_000);
    return () => window.clearInterval(timer);
  }, [lastUpdatedAt]);

  const showToast = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const handleError = useCallback((nextError) => {
    console.error(nextError);
    setError(humanizeError(nextError));
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!apiRef.current) return;
    setRefreshing(true);
    try {
      const next = await apiRef.current.queries.dashboard();
      const updatedAt = new Date();
      setData(next);
      setLastUpdated(clock(updatedAt));
      setLastUpdatedAt(updatedAt);
      setStale(false);
      setError(null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!session) return undefined;

    const api = createControlCentre({
      supabase,
      refresh: loadDashboard,
      onPaymentWaiting: () => {
        showToast("New payment request — a customer is waiting");
      },
      onConnectionState: ({ status, error: realtimeError }) => {
        setConnection(status);
        if (realtimeError) handleError(realtimeError);
      },
      onMutationState: setMutation,
      onError: handleError,
    });

    apiRef.current = api;
    setApiClient(api);
    api.start();
    api.refreshNow("initial-load").catch(handleError);

    const handleFocus = () => api.scheduleRefresh("window-focus");
    const handleOnline = () => api.scheduleRefresh("browser-online");
    const handleVisibility = () => {
      if (document.visibilityState === "visible") api.scheduleRefresh("tab-visible");
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      api.stop().catch(handleError);
      apiRef.current = null;
      setApiClient(null);
    };
  }, [session, loadDashboard, showToast, handleError]);

  const refresh = useCallback(() => {
    apiRef.current?.refreshNow("manual-refresh").catch(handleError);
  }, [handleError]);

  const signOut = useCallback(async () => {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      handleError(signOutError);
      return;
    }
    router.replace("/login");
  }, [handleError, router]);

  const paymentCount = data.paymentQueue.filter(
    (item) => item.status === "pending_review" && !item.human_help_required,
  ).length;

  const helpCount = data.openQueries.length;
  const locationCount = data.orderPins.filter((pin) => pin.location_quality !== "confirmed").length;

  const childProps = useMemo(
    () => ({
      data,
      api: apiClient,
      onError: handleError,
      onToast: showToast,
      onRefresh: refresh,
      onNavigate: setActiveTab,
    }),
    [data, apiClient, handleError, showToast, refresh],
  );

  if (!authReady || (session && !apiClient)) {
    return <div className="app-loading">Opening Getit…</div>;
  }

  if (!session) return <div className="app-loading">Taking you to sign in…</div>;

  const connectionProblem = !browserOnline || connection !== "SUBSCRIBED" || stale;

  return (
    <div className="app-shell">
      <Topbar
        connection={connection}
        browserOnline={browserOnline}
        stale={stale}
        lastUpdated={lastUpdated}
        paymentCount={paymentCount}
        helpCount={helpCount}
        locationCount={locationCount}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        refreshing={refreshing}
        onRefresh={refresh}
        onSignOut={signOut}
      />

      <FocusStrip data={data} activeTab={activeTab} onNavigate={setActiveTab} />

      {connectionProblem && (
        <div className={`connection-banner ${browserOnline ? "warning" : "offline"}`}>
          <div>
            <strong>{!browserOnline ? "This device is offline" : stale ? "Updates look delayed" : "Reconnecting to live updates"}</strong>
            <span>{!browserOnline ? "Changes will not sync until the internet returns." : "The dashboard is keeping your current data visible while it reconnects."}</span>
          </div>
          <button type="button" className="small-button" onClick={refresh} disabled={refreshing || !browserOnline}>
            {refreshing ? "Refreshing…" : "Try again"}
          </button>
        </div>
      )}

      {error && (
        <div className="global-error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
        </div>
      )}
      {mutation?.state === "saving" && (
        <div className="saving-strip">{mutation.label}…</div>
      )}
      {toast && <div className="toast">{toast}</div>}

      {!apiClient ? (
        <div className="app-loading">Connecting to Supabase…</div>
      ) : activeTab === "operations" ? (
        <DriverBoard {...childProps} />
      ) : activeTab === "payments" ? (
        <PaymentQueue {...childProps} />
      ) : activeTab === "map" ? (
        <OperationsMap {...childProps} />
      ) : (
        <SupportQueue {...childProps} />
      )}
    </div>
  );
}
