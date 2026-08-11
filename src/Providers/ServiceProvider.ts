import { Service, Encoding } from "../Services/Service";

export enum ServiceType {
    "SJIStoUTF8",
    "UTF8toSJIS",
}

export class ServiceProvider {

    public provide(pattern: ServiceType): Service {
        switch (pattern) {
            case ServiceType.UTF8toSJIS:
                return new Service({srcEncoding: Encoding.UTF8, distEncoding: Encoding.Shift_JIS});
            case ServiceType.SJIStoUTF8:
            default:
                return new Service({srcEncoding: Encoding.Shift_JIS, distEncoding: Encoding.UTF8});
        }
    }
}
