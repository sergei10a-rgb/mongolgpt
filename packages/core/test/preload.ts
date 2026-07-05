import path from "path"

process.env.MONGOLGPT_DB = ":memory:"
process.env.MONGOLGPT_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.MONGOLGPT_DISABLE_MODELS_FETCH = "true"
