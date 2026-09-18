using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "longbridge-test", worker = (
    compatibilityDate = "2025-01-01",
    modules = [
      (name = "longbridge-test.mjs", esModule = embed "longbridge-test.mjs"),
      (name = "longbridge.mjs", esModule = embed "../../src/longbridge.mjs"),
      (name = "engine.mjs", esModule = embed "../../src/engine.mjs")
    ]
  ))]
);
