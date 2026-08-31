"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AutomationBacklog from "../components/AutomationBacklog";
import CatalogueManager from "../components/CatalogueManager";
import DriverBoard from "../components/DriverBoard";
import FocusStrip from "../components/FocusStrip";
import FloatingChatDock from "../components/FloatingChatDock";
import MessagingInbox from "../components/MessagingInbox";
import OperationsMap from "../components/OperationsMap";
import PartnerApplications from "../components/PartnerApplications";
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
  health: null,
  messagingInbox: [],
  messagingDirectory: [],
  messagingHealth: null,
  partnerApplications: [],
  partnerCatalogueSubmissions: [],
  partnerApplicationFiles: [],
  partnerApplicationFieldDefinitions: [],
  partnerApplicationFieldValues: [],
  partnerApplicationExtractionJobs: [],
  partnerOnboardingRequirements: [],
  automationEvents: [],
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
  const [realtimeRevision, setRealtimeRevision] = useState(0);

  useEffect(() => {
    let mounted = true;
    let redirectTimer = null;
    const readinessTimer = window.setTimeout(() => {
      if (!mounted) return;
      setAuthReady(true);
      setSession(null);
      redirectTimer = window.setTimeout(() => router.replace("/login"), 0);
    }, 8_000);

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      window.clearTimeout(readinessTimer);
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) {
        redirectTimer = window.setTimeout(() => router.replace("/login"), 0);
      }
    });

    return () => {
      mounted = false;
      window.clearTimeout(readinessTimer);
      window.clearTimeout(redirectTimer);
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
      onRealtimeEvent: ({ table }) => {
        if (table.startsWith("messaging_")) setRealtimeRevision((value) => value + 1);
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
  const messagingCount = data.messagingInbox.filter((conversation) => conversation.requires_attention).length;
  const applicationsCount = data.partnerApplications.filter((application) => ["submitted", "reviewing"].includes(application.status)).length;
  const automationCount = Number(data.health?.automation_backlog || 0);

  const childProps = useMemo(
    () => ({
      data,
      api: apiClient,
      onError: handleError,
      onToast: showToast,
      onRefresh: refresh,
      onNavigate: setActiveTab,
      realtimeRevision,
    }),
    [data, apiClient, handleError, showToast, refresh, realtimeRevision],
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
        messagingCount={messagingCount}
        applicationsCount={applicationsCount}
        automationCount={automationCount}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        refreshing={refreshing}
        onRefresh={refresh}
        onSignOut={signOut}
      />

      <FocusStrip data={data} activeTab={activeTab} onNavigate={setActiveTab} />

      {data.health?.status === "attention" && (
        <div className="system-health-banner">
          <div>
            <strong>Automation queue needs attention</strong>
            <span>
              {data.health.automation_backlog || 0} older updates are waiting
              {data.health.stuck_processing
                ? ` and ${data.health.stuck_processing} are stuck in processing`
                : ""}.
              Nothing has been retried automatically, so customer messages and payments stay protected.
            </span>
          </div>
          <button type="button" className="small-button" onClick={refresh} disabled={refreshing || !browserOnline}>
            {refreshing ? "Checking…" : "Check again"}
          </button>
        </div>
      )}

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
      ) : activeTab === "catalogue" ? (
        <CatalogueManager onError={handleError} onToast={showToast} />
      ) : activeTab === "messaging" ? (
        <MessagingInbox {...childProps} />
      ) : activeTab === "applications" ? (
        <PartnerApplications {...childProps} />
      ) : activeTab === "automation" ? (
        <AutomationBacklog {...childProps} />
      ) : (
        <SupportQueue {...childProps} />
      )}

      <FloatingChatDock {...childProps} />
    </div>
  );
}
