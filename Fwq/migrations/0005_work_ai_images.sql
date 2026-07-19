ALTER TABLE work_ai_providers ADD COLUMN image_generation_path TEXT NOT NULL DEFAULT '/images/generations';
ALTER TABLE work_ai_providers ADD COLUMN default_image_model TEXT;
ALTER TABLE work_ai_providers ADD COLUMN image_models_json TEXT NOT NULL DEFAULT '[]';
