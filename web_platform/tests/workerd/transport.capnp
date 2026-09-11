using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "transport-test", worker = (
      compatibilityDate = "2025-01-01",
      modules = [
        (name = "transport-test.mjs", esModule = embed "transport-test.mjs"),
        (name = "transport.mjs", esModule = embed "../../src/transport.mjs"),
        (name = "engine.mjs", esModule = embed "../../src/engine.mjs")
      ],
      globalOutbound = (name = "alpaca-fixture")
    )),
    (name = "alpaca-fixture", worker = (
      compatibilityDate = "2025-01-01",
      modules = [(name = "fixture.mjs", esModule = embed "fixture.mjs")]
    ))
  ]
);
