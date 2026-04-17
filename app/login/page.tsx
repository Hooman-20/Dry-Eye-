"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        router.replace("/");
      }
    });

    return () => unsub();
  }, [router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#000", color: "#fff", padding: 20 }}>
      <form onSubmit={onSubmit} style={{ width: "min(420px, 100%)", background: "#111", border: "1px solid #333", borderRadius: 12, padding: 20 }}>
        <h1 style={{ marginTop: 0 }}>Login</h1>

        <label style={{ display: "block", marginBottom: 10 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 8, border: "1px solid #444", background: "#000", color: "#fff" }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 10 }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: "100%", marginTop: 6, padding: 10, borderRadius: 8, border: "1px solid #444", background: "#000", color: "#fff" }}
          />
        </label>

        {error && <p style={{ color: "#ff7f7f", fontSize: 14 }}>{error}</p>}

        <button type="submit" disabled={loading} style={{ width: "100%", padding: 10, borderRadius: 8, cursor: "pointer" }}>
          {loading ? "Logging in..." : "Log in"}
        </button>

        <p style={{ marginTop: 12, fontSize: 14 }}>
          No account yet? <Link href="/signup">Create one</Link>
        </p>
      </form>
    </div>
  );
}
