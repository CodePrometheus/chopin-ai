import { PluginError } from "@earendil-works/chord";

/** A stable application error code, independent of the transport runtime's own errors. */
export class ServiceError extends PluginError {
  constructor(code: string, message: string) {
    super(code, `${code}: ${message}`);
  }
}

export function refusal(code: string, message: string): ServiceError {
  return new ServiceError(code, message);
}
