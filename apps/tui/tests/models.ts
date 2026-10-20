import { InMemoryCredentialStore, type CredentialStore, type Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** A model runtime with the built-in providers and `providers`, keeping credentials in `credentials` and nowhere else. */
export async function runtimeWith(providers: readonly Provider[] = [], credentials: CredentialStore = new InMemoryCredentialStore()): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  for (const provider of providers) runtime.registerNativeProvider(provider);
  return runtime;
}
