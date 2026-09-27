interface IngestEnv {
  readonly OPENAI_API_KEY: string;
  readonly MISTRAL_API_KEY: string;
  readonly R2_AUDIO_PRESIGN_ACCESS_KEY_ID: string;
  readonly R2_AUDIO_PRESIGN_SECRET_ACCESS_KEY: string;
  readonly GEMINI_API_KEY?: string;
  /** "true" publishes discovered episodes automatically when processing completes. */
  readonly AIC_INGEST_AUTO_PUBLISH?: string;
  readonly GEMINI_INTELLIGENCE_MODEL?: string;
  readonly GEMINI_INTELLIGENCE_URL?: string;
  readonly GEMINI_INTELLIGENCE_MAX_TOKENS?: string | number;
  readonly SILO_TEMP_KEY?: string;
  readonly SILO_INTELLIGENCE_URL?: string;
  readonly SILO_INTELLIGENCE_MODEL?: string;
  readonly SILO_INTELLIGENCE_BACKEND_MODE?: string;
  readonly SILO_INTELLIGENCE_REASONING?: string;
  readonly SILO_INTELLIGENCE_MAX_TOKENS?: string | number;
}
