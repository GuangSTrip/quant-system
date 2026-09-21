using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "auth-test", worker = (
      compatibilityDate = "2025-01-01",
      modules = [
        (name = "auth-test.mjs", esModule = embed "auth-test.mjs"),
        (name = "auth.mjs", esModule = embed "../../src/auth.mjs"),
        (name = "intraday-kernel.mjs", esModule = embed "../../src/intraday-kernel.mjs"),
        (name = "minute-rules.mjs", esModule = embed "../../src/minute-rules.mjs"),
        (name = "engine.mjs", esModule = embed "../../src/engine.mjs")
      ]
    ))
  ]
);
