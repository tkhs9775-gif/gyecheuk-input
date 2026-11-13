package com.kiwoomenc.gyecheuk;

public final class RustCore {
    private static boolean loaded = false;

    static {
        try {
            System.loadLibrary("gyecheuk_core");
            loaded = true;
        } catch (UnsatisfiedLinkError ignored) {
            loaded = false;
        }
    }

    private RustCore() {}

    public static boolean isLoaded() {
        return loaded;
    }

    public static native String ping();

    public static native String sanitizeFilename(String input);
}
