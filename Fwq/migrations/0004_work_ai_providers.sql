CREATE TABLE work_ai_providers (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  chat_completions_path TEXT NOT NULL DEFAULT '/chat/completions',
  model TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  api_key_ciphertext TEXT NOT NULL,
  api_key_iv TEXT NOT NULL,
  api_key_preview TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);

CREATE INDEX idx_work_ai_providers_user_updated
  ON work_ai_providers(user_id, updated_at DESC);

INSERT INTO work_ai_providers (
  user_id, provider_id, display_name, base_url, chat_completions_path, model,
  models_json, api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
)
SELECT
  user_id, 'default', '默认接口', base_url, chat_completions_path, model,
  json_array(model), api_key_ciphertext, api_key_iv, api_key_preview, created_at, updated_at
FROM work_ai_configs;
