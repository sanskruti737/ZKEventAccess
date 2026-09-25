import React from 'react';
import { GlobeIcon, LockIcon, ShieldCheckIcon } from './Icon';

export interface LayoutProps {
  readonly network: string;
  readonly children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ network, children }) => (
  <div className="app-shell">
    <div className="page-container">
      <header className="app-header">
        <a className="brand-lockup" href="/" aria-label="ZK Event Access home">
          <img className="brand-logo" src="/zk-event-access.svg" alt="" />
          <span className="brand-copy">
            <span className="brand-name">ZK Event Access</span>
            <span className="brand-caption">Private event credentials</span>
          </span>
        </a>
        <nav className="header-nav" aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#identity">Identity</a>
          <a href="#access-ledger">Access ledger</a>
        </nav>
        <div className="header-meta">
          <span className="network-pill">
            <span className="network-dot" aria-hidden="true" />
            {network || 'preprod'} network
          </span>
          <span className="header-badge">
            <ShieldCheckIcon width="14" height="14" />
            Zero-knowledge access
          </span>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Event infrastructure
          </div>
          <h1 id="hero-title">
            Prove access.
            <br />
            <span>Keep it private.</span>
          </h1>
          <p className="hero-description">
            Issue and verify event credentials without revealing who holds them. The public ledger stays
            auditable; organizer authority stays wallet-backed.
          </p>
        </div>

        <aside className="hero-aside" id="how-it-works" aria-label="ZK Event Access principles">
          <div className="hero-aside-label">Built for accountable access</div>
          <h2 className="hero-aside-title">A clear count. A quieter identity.</h2>
          <p className="hero-aside-copy">
            ZK Event Access separates the information an event needs to publish from the information only its
            organizer should control.
          </p>
          <ul className="principles">
            <li className="principle">
              <span className="principle-index">01</span>
              Public counts for operational clarity
            </li>
            <li className="principle">
              <span className="principle-index">02</span>
              Wallet-backed organizer authority
            </li>
            <li className="principle">
              <span className="principle-index">03</span>
              No credential data in the interface
            </li>
          </ul>
        </aside>
      </section>

      <main className="app-content">{children}</main>

      <footer className="app-footer">
        <p>
          <LockIcon width="13" height="13" aria-hidden="true" /> Public ledger data is shown here for verification.
          Organizer secrets stay with the connected wallet and are never pasted into the app.
        </p>
        <span className="footer-signature">
          <GlobeIcon width="14" height="14" aria-hidden="true" />
          Midnight · {network || 'preprod'}
        </span>
      </footer>
    </div>
  </div>
);
