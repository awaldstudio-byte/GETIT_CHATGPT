"use client";

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let redirectTimer = null;
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" && session) {
        redirectTimer = window.setTimeout(() => {
          window.location.replace("/dashboard");
        }, 0);
      }
    });

    return () => {
      window.clearTimeout(redirectTimer);
      listener.subscription.unsubscribe();
    };
  }, []);

  async function signIn(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    if (!data.session) {
      setMessage("Sign-in completed without a staff session. Please try again.");
      setLoading(false);
      return;
    }

    window.location.assign("/dashboard");
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-logo-shell login-logo">
          <img src="/getit-mark.png" alt="Getit" className="brand-logo" />
        </div>
        <p className="eyebrow">GETIT OPERATIONS</p>
        <h1>Control Centre</h1>
        <p className="muted">Sign in using your authorised Getit staff account.</p>

        <form onSubmit={signIn} className="login-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {message && <p className="error-message">{message}</p>}
          <button className="primary-button" disabled={loading} type="submit">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
