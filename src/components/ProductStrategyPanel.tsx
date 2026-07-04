import { agentCapabilityStages, productPositioning, providerPresets } from "../productStrategy";

export function ProductStrategyPanel() {
  return (
    <section className="productStrategyPanel" aria-label="Rcode product strategy">
      <header>
        <p>Rcode</p>
        <h2>{productPositioning.tagline}</h2>
        <p>{productPositioning.modelStrategy}</p>
      </header>

      <section>
        <h3>Provider Presets</h3>
        <ul>
          {providerPresets.map((provider) => (
            <li key={provider.id}>
              <strong>{provider.label}</strong>
              <span> · {provider.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Agent Stages</h3>
        <ol>
          {agentCapabilityStages.map((stage) => (
            <li key={stage.id}>
              <strong>{stage.title}</strong>
              <p>{stage.description}</p>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
