function compactModelReference(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelAliases(model: string): string[] {
  const tail = model.split(/[\/:]/).pop() || model;
  const compact = compactModelReference(model);
  const compactTail = compactModelReference(tail);
  const shortTail = compactTail.replace(/^(?:openai|gpt)/, "");
  return [...new Set([compact, compactTail, shortTail].filter((alias) => alias.length >= 4))];
}

function looksLikeImageModel(reference: string): boolean {
  const compact = compactModelReference(reference);
  return /^(?:gpt)?image|dalle|imagen|flux|sdxl|stablediffusion|recraft|seedream|midjourney/.test(compact)
    || (/[a-z]/.test(compact) && /\d/.test(compact));
}

function isDirectImageRequest(prompt: string): boolean {
  return /(?:生图|(?:用|使用|通过).{0,48}(?:生成|画|绘制|创作|渲染|制作|出图))|(?:using|with).{0,48}(?:generate|create|draw|paint|render)/i.test(prompt);
}

export function requestedImageModel(prompt: string, models: string[]): { model?: string; reference?: string } {
  const references = prompt.normalize("NFKC").match(/[A-Za-z0-9][A-Za-z0-9._:/-]*/g) ?? [];
  const compactReferences = new Set(references.map(compactModelReference));
  for (const model of models) {
    if (modelAliases(model).some((alias) => compactReferences.has(alias))) return { model, reference: model };
  }

  const explicit = prompt.match(/(?:用|使用|通过|using|with)\s*[“”"'`]?([A-Za-z0-9][A-Za-z0-9._:/-]*)/i)?.[1];
  return explicit && looksLikeImageModel(explicit) && isDirectImageRequest(prompt) ? { reference: explicit } : {};
}
