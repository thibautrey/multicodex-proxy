import { useState } from "react";
import { HostHarnessCards } from "./HostHarnessCarousel";

type Props = {
  accountCount: number;
  cloudUrl: string;
  onComplete: () => void;
  onHarnessesChanged: () => Promise<void>;
  onOpenProviderSetup: () => void;
};

const STEPS = ["Harness", "Provider", "Cloud"];

export function HostOnboarding({
  accountCount,
  cloudUrl,
  onComplete,
  onHarnessesChanged,
  onOpenProviderSetup,
}: Props) {
  const [step, setStep] = useState(0);

  return (
    <div className="modal-backdrop host-onboarding-backdrop" role="presentation">
      <section
        className="modal panel host-onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-onboarding-title"
      >
        <header className="host-onboarding-header">
          <div>
            <span className="eyebrow">Welcome to MultiVibe Host</span>
            <div className="host-onboarding-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
              {STEPS.map((label, index) => (
                <span className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
                  <i aria-hidden="true">{index + 1}</i>
                  {label}
                </span>
              ))}
            </div>
          </div>
          <button className="btn ghost host-onboarding-skip" type="button" onClick={onComplete}>
            Skip setup
          </button>
        </header>

        <div className="host-onboarding-content">
          {step === 0 && (
            <>
              <div className="host-onboarding-copy">
                <h2 id="host-onboarding-title">Connect your coding tool</h2>
                <p>Choose a detected harness. You can change this later.</p>
              </div>
              <HostHarnessCards variant="onboarding" onApiKeysChanged={onHarnessesChanged} />
            </>
          )}

          {step === 1 && (
            <div className="host-onboarding-simple-step">
              <div className="host-onboarding-step-icon" aria-hidden="true">+</div>
              <div className="host-onboarding-copy">
                <h2 id="host-onboarding-title">Add a provider</h2>
                <p>Connect one account so MultiVibe has models to route.</p>
              </div>
              {accountCount > 0 ? (
                <div className="host-onboarding-ready" role="status">
                  <span aria-hidden="true">✓</span>
                  Provider connected
                </div>
              ) : (
                <button className="btn" type="button" onClick={onOpenProviderSetup}>
                  Configure a provider
                </button>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="host-onboarding-simple-step">
              <img className="host-onboarding-cloud-icon" src="/assets/brand/multivibe-app-icon.svg" alt="" />
              <div className="host-onboarding-copy">
                <span className="badge">Optional</span>
                <h2 id="host-onboarding-title">Connect MultiVibe Cloud</h2>
                <p>Sign in to your cloud account, or do this later.</p>
              </div>
              <a className="btn secondary" href={cloudUrl} target="_blank" rel="noreferrer">
                Open MultiVibe Cloud
              </a>
            </div>
          )}
        </div>

        <footer className="host-onboarding-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={step === 0}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              className="btn"
              type="button"
              disabled={step === 1 && accountCount === 0}
              onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}
            >
              Continue
            </button>
          ) : (
            <button className="btn" type="button" onClick={onComplete}>
              Finish
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
