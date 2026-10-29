package com.kiwoomenc.gyecheuk;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_CAMERA_PERM = 1002;
    private static final int REQ_NOTIFY_PERM = 1003;
    private static final int REQ_CAMERA = 1004;
    private static final int REQ_LOCATION_PERM = 1005;
    private static final int MAX_BURST = 50;   // 웹 화면·서버의 사진 한도(MAX_PHOTOS)와 같다
    private static final long DAY_MS = 24L * 60 * 60 * 1000;
    private static final long SHOT_KEEP_MS = DAY_MS;               // 화면에 넘긴 촬영 원본(앱 캐시)을 남겨 두는 시간
    private static final long LOST_SHOT_KEEP_MS = 7 * DAY_MS;      // 앱이 닫혀 못 넘긴 촬영 원본은 복구할 수 있게 더 오래 둔다
    private static final long BACK_EXIT_MS = 2000;                 // 이 안에 뒤로가기를 한 번 더 누르면 앱을 닫는다
    private static final String SHOT_PREFS = "shots";
    private static final String KEY_PENDING = "pending";           // 찍었지만 아직 웹 화면에 넘기지 못한 사진 파일 경로들
    private static final String PHOTO_ROOT = "계측사진";
    private static final String RECOVER_FOLDER = "촬영복구";
    // 직원용/감독판 APK마다 시작 화면이 다르다 (app/build.gradle 의 productFlavors)
    private static final String LIVE_URL = BuildConfig.LIVE_URL;
    private static final String LOCAL_URL = BuildConfig.LOCAL_URL;
    // 우리 화면 주소의 폴더(…/gyecheuk-input/). 이 아래만 앱 안에서 열고, 다른 주소는 휴대폰 브라우저로 넘긴다
    private static final String LIVE_PREFIX = LIVE_URL.substring(0, LIVE_URL.lastIndexOf('/') + 1);

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraPhotoUri;
    private WebChromeClient.FileChooserParams pendingChooserParams;
    private final ArrayList<Uri> burstShots = new ArrayList<>();   // 연속 촬영으로 지금까지 찍은 사진
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private long lastBackAt;
    private boolean clearHistoryOnce;   // 앱 안 사본으로 바꿔 연 뒤 한 번: 실패한 주소가 뒤로가기 기록에 남아 있으면 뒤로가기 때 또 실패→사본을 되풀이한다

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 서비스 워커가 화면 파일을 받으러 나가는 요청도 신호가 없으면 앱 안 화면 파일로 답한다(offlineAsset)
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return offlineAsset(request);
            }
        });
        webView = createWebView();
        setContentView(webView);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY_PERM);
        }
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t ->
            getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().putString(PushService.KEY_TOKEN, t).apply());

        // 신호가 없어도 늘 최신 화면 주소로 연다: 웹 화면의 서비스 워커가 폰에 저장해 둔 최신 화면을 보여 준다.
        // (예전처럼 앱에 들어 있는 옛 사본을 열면 접속 코드·목록·보관함이 따로라 보관한 입력이 안 보였다)
        // 저장해 둔 화면조차 없을 때(설치 직후 신호 없음)만 onReceivedError가 앱 안 사본을 연다
        webView.loadUrl(LIVE_URL);

        new Thread(this::cleanOldShots).start();
        offerLostShots();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 앱 안 사본(file:///android_asset/)은 이 설정과 상관없이 열린다. 그 밖의 폰 파일을 웹 화면이 읽지 못하게 막는다
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);   // 카메라·갤러리에서 고른 사진(content://)
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        view.addJavascriptInterface(new GalleryBridge(), "AndroidGallery");
        view.addJavascriptInterface(new PushBridge(), "AndroidPush");
        view.addJavascriptInterface(new AppBridge(), "AndroidApp");
        if (BuildConfig.IS_PRO) {
            s.setGeolocationEnabled(true);
            view.addJavascriptInterface(new ProBridge(), "AndroidPro");
        }
        // 내려받기 링크(새 APK 등)는 휴대폰 브라우저가 받게 한다. 웹뷰는 스스로 파일을 내려받지 못한다
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> openOutside(Uri.parse(url)));

        view.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                return offlineAsset(request);
            }

            @Override
            public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(LIVE_URL)) {
                    clearHistoryOnce = true;
                    v.loadUrl(LOCAL_URL);
                }
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (clearHistoryOnce && url != null && url.startsWith("file:")) {
                    clearHistoryOnce = false;
                    v.clearHistory();
                }
            }

            // 바깥 주소(드라이브 사진 링크, 지도 출처 등)는 앱 안이 아니라 휴대폰 브라우저로 연다.
            // 앱 안에서 열면 그 사이트도 이 앱의 사진 저장 기능(AndroidGallery)을 부를 수 있기 때문
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isOurPage(url)) return false;
                if (request.isForMainFrame()) openOutside(url);
                return true;
            }

            // 도면을 크게 확대하다 메모리가 모자라 화면(렌더러)이 죽으면 앱 전체가 꺼지는 대신 화면만 새로 띄운다.
            // 적던 입력은 웹 화면의 임시저장·보관함에 남아 있다
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                if (v == webView) restartWebView();
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("확인", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("확인", (d, w) -> result.confirm())
                    .setNegativeButton("취소", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }

            // Pro 앱의 우리 화면(GitHub Pages 또는 앱 안 사본)에만 위치를 준다. 휴대폰 위치 권한이 없으면 먼저 묻는다
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean ours = BuildConfig.IS_PRO && origin != null && (LIVE_URL.startsWith(origin) || origin.startsWith("file"));
                if (!ours) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                    return;
                }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION_PERM);
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = filePathCallback;
                if (fileChooserParams.isCaptureEnabled() && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    pendingChooserParams = fileChooserParams;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERM);
                    return true;
                }
                launchChooser(fileChooserParams);
                return true;
            }
        });
        return view;
    }

    // 신호가 없을 때 우리 화면 주소(…/gyecheuk-input/xxx)의 화면 파일을 앱 안 사본(assets/www/xxx)으로 답한다.
    // 주소가 그대로라 접속 코드·목록·보관함(같은 주소에 저장됨)이 그대로 보인다. (앱 안 사본을 file:// 주소로 열면 저장소가 따로라
    // 접속 코드·목록이 없어 '서버에 연결할 수 없습니다'에서 멈췄다.) 신호가 있으면 null: 평소대로 인터넷·서비스 워커가 처리한다.
    // ponytail: 앱 안 사본은 APK를 만든 때의 화면이라 신호가 없을 때는 그 판으로 열린다. 새 화면이 꼭 필요하면 APK를 새로 만든다
    private WebResourceResponse offlineAsset(WebResourceRequest request) {
        String url = request.getUrl().toString();
        if (!"GET".equals(request.getMethod()) || !url.startsWith(LIVE_PREFIX) || hasInternet()) return null;
        String path = request.getUrl().getPath();
        String base = Uri.parse(LIVE_PREFIX).getPath();
        String name = path == null || base == null || path.length() <= base.length() ? "index.html" : path.substring(base.length());
        if (name.isEmpty()) name = "index.html";
        if (name.contains("..")) return null;
        try {
            InputStream in = getAssets().open("www/" + name);
            WebResourceResponse res = new WebResourceResponse(mimeOf(name), "utf-8", in);
            // 서비스 워커가 이 옛 사본을 최신 화면으로 알고 저장하지 않게 표시한다(sw.js가 이 머리를 보면 저장하지 않음)
            res.setResponseHeaders(java.util.Collections.singletonMap("X-Offline-Copy", "1"));
            return res;
        } catch (IOException e) {
            return null;   // 앱 안에 없는 파일은 평소대로 실패하게 둔다
        }
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    // 휴대폰이 인터넷에 연결돼 있다고 확인된 상태인지(비행기 모드·데이터 꺼짐·인터넷 안 되는 와이파이면 false)
    private boolean hasInternet() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) {
            return true;   // 모르면 평소대로
        }
    }

    private static boolean isOurPage(Uri url) {
        String s = url.toString();
        if (s.startsWith(LIVE_PREFIX)) return true;
        if ("about".equals(url.getScheme())) return true;
        return "file".equals(url.getScheme()) && url.getPath() != null && url.getPath().startsWith("/android_asset/www/");
    }

    private void openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, "이 주소를 열 앱이 없습니다.", Toast.LENGTH_SHORT).show();
        }
    }

    // ponytail: 같은 도면에서 곧바로 또 죽으면 다시 띄우기를 되풀이한다. 실제로 되풀이되면 확대 상한(웹 MAX_CANVAS_PX)을 낮출 것
    private void restartWebView() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        burstShots.clear();
        WebView old = webView;
        webView = createWebView();
        setContentView(webView);
        old.destroy();
        webView.loadUrl(LIVE_URL);
        Toast.makeText(this, "메모리가 모자라 화면을 다시 열었습니다. 적던 내용은 임시저장에서 이어집니다.", Toast.LENGTH_LONG).show();
    }

    private void launchChooser(WebChromeClient.FileChooserParams params) {
        try {
            if (params.isCaptureEnabled()) {
                burstShots.clear();
                if (launchCamera()) return;
            }
            Intent contentIntent = params.createIntent();
            if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                contentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            startActivityForResult(contentIntent, REQ_FILE_CHOOSER);
        } catch (Exception e) {
            cancelChooser("촬영·파일 선택 창을 열 수 없습니다. 다시 시도해 주세요.");
        }
    }

    // 선택 창을 못 열었을 때: 웹 쪽 대기를 풀고, 조용히 끝나지 않게 이유를 띄운다
    private void cancelChooser(String message) {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        cameraPhotoUri = null;
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private boolean launchCamera() {
        Intent camIntent = createCameraIntent();
        if (camIntent == null) return false;
        startActivityForResult(camIntent, REQ_CAMERA);
        return true;
    }

    // 연속 촬영: 한 장 찍으면 카메라를 바로 다시 연다. 카메라에서 뒤로가기(취소)를 누르면 지금까지 찍은 사진을 한꺼번에 웹 화면에 넘긴다.
    // 촬영 중 휴대폰 메모리가 모자라 이 앱이 닫히면 웹 쪽 대기가 사라진다: 찍은 파일 경로를 적어 두었다가 다음에 켤 때 갤러리 저장을 권한다(offerLostShots)
    private void onCameraResult(int resultCode) {
        if (fileCallback == null) {
            burstShots.clear();
            cameraPhotoUri = null;
            return;
        }
        if (resultCode == Activity.RESULT_OK && cameraPhotoUri != null) {
            burstShots.add(cameraPhotoUri);
            cameraPhotoUri = null;
            if (burstShots.size() < MAX_BURST) {
                try {
                    if (launchCamera()) {
                        Toast.makeText(this, burstShots.size() + "장 찍음 · 계속 찍거나, 다 찍었으면 뒤로가기", Toast.LENGTH_SHORT).show();
                        return;
                    }
                } catch (Exception e) {
                    // 카메라를 다시 못 열면 찍은 것까지 넘긴다
                }
            }
        }
        cameraPhotoUri = null;
        fileCallback.onReceiveValue(burstShots.isEmpty() ? null : burstShots.toArray(new Uri[0]));
        fileCallback = null;
        burstShots.clear();
        setPendingShots(new HashSet<>());   // 웹 화면에 넘겼다
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private Intent createCameraIntent() {
        try {
            File photoFile = new File(getCacheDir(), "shot_" + System.currentTimeMillis() + ".jpg");
            cameraPhotoUri = PhotoFileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Set<String> pending = getPendingShots();
            pending.add(photoFile.getAbsolutePath());
            setPendingShots(pending);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return intent;
        } catch (Exception e) {
            cameraPhotoUri = null;
            return null;
        }
    }

    // ---------- 촬영 원본 정리·복구 ----------

    private Set<String> getPendingShots() {
        return new HashSet<>(getSharedPreferences(SHOT_PREFS, MODE_PRIVATE).getStringSet(KEY_PENDING, new HashSet<>()));
    }

    private void setPendingShots(Set<String> paths) {
        getSharedPreferences(SHOT_PREFS, MODE_PRIVATE).edit().putStringSet(KEY_PENDING, paths).apply();
    }

    // 카메라 원본(장당 3~5MB)은 웹 화면이 줄여서 올린 뒤에는 필요 없다. 하루 지난 것은 지운다(못 넘긴 것은 일주일 둔다)
    private void cleanOldShots() {
        File[] files = getCacheDir().listFiles((dir, name) -> name.startsWith("shot_") && name.endsWith(".jpg"));
        if (files == null) return;
        Set<String> pending = getPendingShots();
        long now = System.currentTimeMillis();
        for (File f : files) {
            long keep = pending.contains(f.getAbsolutePath()) ? LOST_SHOT_KEEP_MS : SHOT_KEEP_MS;
            if (now - f.lastModified() > keep && !f.delete()) f.deleteOnExit();
        }
    }

    // 지난번 연속 촬영 중 앱이 닫혀 웹 화면에 넘기지 못한 사진이 있으면 갤러리에 저장할지 묻는다
    private void offerLostShots() {
        List<File> lost = new ArrayList<>();
        for (String p : getPendingShots()) {
            File f = new File(p);
            if (f.isFile() && f.length() > 0) lost.add(f);
        }
        if (lost.isEmpty()) {
            setPendingShots(new HashSet<>());
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("촬영 사진 복구")
            .setMessage("지난번 연속 촬영 중 앱이 닫혀 화면으로 넘기지 못한 사진 " + lost.size() + "장이 있습니다.\n"
                + "갤러리 「" + PHOTO_ROOT + "/" + RECOVER_FOLDER + "」 폴더에 저장할까요?\n(저장한 뒤 입력 화면에서 갤러리로 골라 올리면 됩니다)")
            .setPositiveButton("갤러리에 저장", (d, w) -> saveLostShots(lost))
            .setNegativeButton("나중에", null)
            .setCancelable(false)
            .show();
    }

    private void saveLostShots(List<File> lost) {
        String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.KOREA).format(new Date());
        int saved = 0;
        for (int i = 0; i < lost.size(); i++) {
            File f = lost.get(i);
            try {
                if (writeImage(Files.readAllBytes(f.toPath()), RECOVER_FOLDER, "복구_" + stamp + "_" + (i + 1) + ".jpg")) {
                    saved++;
                    if (!f.delete()) f.deleteOnExit();
                }
            } catch (Exception e) {
                // 못 읽은 파일은 남겨 두고 다음에 다시 묻는다
            }
        }
        if (saved == lost.size()) setPendingShots(new HashSet<>());
        Toast.makeText(this, "사진 " + saved + "장을 갤러리 「" + PHOTO_ROOT + "/" + RECOVER_FOLDER + "」에 저장했습니다.", Toast.LENGTH_LONG).show();
    }

    // ---------- 권한·결과 ----------

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION_PERM && pendingGeoCallback != null) {
            boolean granted = false;
            for (int r : grantResults) granted |= r == PackageManager.PERMISSION_GRANTED;
            pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
            return;
        }
        if (requestCode == REQ_CAMERA_PERM && pendingChooserParams != null) {
            WebChromeClient.FileChooserParams p = pendingChooserParams;
            pendingChooserParams = null;
            if (grantResults.length == 0 || grantResults[0] != PackageManager.PERMISSION_GRANTED) {
                cancelChooser("카메라 권한이 없어 촬영할 수 없습니다. 설정 > 앱 > 권한에서 카메라를 허용하거나 '갤러리·파일'로 올려 주세요.");
                return;
            }
            launchChooser(p);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CAMERA) {
            onCameraResult(resultCode);
            return;
        }
        if (requestCode != REQ_FILE_CHOOSER || fileCallback == null) return;

        Uri[] results = null;
        if (resultCode == Activity.RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                ClipData clip = data.getClipData();
                List<Uri> uris = new ArrayList<>();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
                results = uris.toArray(new Uri[0]);
            } else if (data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    // 화면 안에서는 뒤로 가고, 맨 처음 화면에서는 한 번 더 눌러야 앱을 닫는다(입력 중 실수로 닫히지 않게)
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < BACK_EXIT_MS) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "한 번 더 누르면 앱이 꺼집니다", Toast.LENGTH_SHORT).show();
    }

    // ---------- 갤러리(계측사진 폴더) 쓰기 ----------

    // 웹 화면이 보낸 폴더 이름("현장/도면/원본" 꼴)을 계측사진 아래 경로로. '..'이나 빈 칸이 끼면 null(계측사진 밖으로 못 나가게)
    private static String safeFolder(String folder) {
        if (folder == null || folder.trim().isEmpty()) return "현장무관";
        StringBuilder out = new StringBuilder();
        for (String part : folder.split("/")) {
            String p = part.trim().replaceAll("[\\\\:*?\"<>|]", "_");
            if (p.isEmpty() || p.equals(".") || p.equals("..")) return null;
            if (out.length() > 0) out.append('/');
            out.append(p);
        }
        return out.toString();
    }

    private static boolean safeName(String name) {
        return name != null && !name.trim().isEmpty() && !name.contains("/") && !name.contains("\\") && !name.contains("..");
    }

    // 계측사진/<folder>/ 안에서 이 앱이 저장한 같은 이름의 그림. 없거나 못 찾으면 null
    private Uri findImage(String relPath, String fileName) {
        String[] cols = {MediaStore.Images.Media._ID};
        String where = MediaStore.Images.Media.DISPLAY_NAME + "=? AND (" + MediaStore.Images.Media.RELATIVE_PATH + "=? OR " + MediaStore.Images.Media.RELATIVE_PATH + "=?)";
        String[] args = {fileName, relPath, relPath + "/"};
        try (Cursor c = getContentResolver().query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cols, where, args, null)) {
            if (c != null && c.moveToFirst()) return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, c.getLong(0));
        } catch (Exception e) {
            // 찾지 못하면 새로 만든다
        }
        return null;
    }

    // 같은 폴더·같은 이름이 있으면 덮어쓴다(예전에는 안드로이드가 '이름 (1).jpg'로 하나 더 만들었다)
    private boolean writeImage(byte[] bytes, String folder, String fileName) throws Exception {
        String safe = safeFolder(folder);
        if (safe == null || !safeName(fileName)) return false;
        String relPath = Environment.DIRECTORY_PICTURES + "/" + PHOTO_ROOT + "/" + safe;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContentResolver();
            Uri existing = findImage(relPath, fileName);
            if (existing != null) {
                try (OutputStream out = resolver.openOutputStream(existing, "wt")) {
                    if (out != null) {
                        out.write(bytes);
                        return true;
                    }
                } catch (Exception e) {
                    // 다른 앱이 만든 같은 이름 파일이거나, 파일은 지워지고 목록만 남은 경우: 아래에서 새로 만든다
                }
            }
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            values.put(MediaStore.Images.Media.RELATIVE_PATH, relPath);
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return false;
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) return false;
                out.write(bytes);
            }
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return true;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), PHOTO_ROOT + "/" + safe);
        if (!dir.exists()) dir.mkdirs();
        File file = new File(dir, fileName);
        try (FileOutputStream fos = new FileOutputStream(file)) {   // 같은 이름이면 덮어쓴다
            fos.write(bytes);
        }
        MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
        return true;
    }

    private boolean deleteImage(String folder, String fileName) {
        String safe = safeFolder(folder);
        if (safe == null || !safeName(fileName)) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri existing = findImage(Environment.DIRECTORY_PICTURES + "/" + PHOTO_ROOT + "/" + safe, fileName);
            try {
                return existing != null && getContentResolver().delete(existing, null, null) > 0;
            } catch (SecurityException e) {
                return false;   // 다른 앱이 만든 파일은 지우지 않는다
            }
        }
        File file = new File(new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), PHOTO_ROOT + "/" + safe), fileName);
        boolean ok = file.delete();
        if (ok) MediaScannerConnection.scanFile(this, new String[]{file.getAbsolutePath()}, null, null);
        return ok;
    }

    // ---------- 웹 화면(JS)이 부르는 기능 ----------

    // 웹 화면(JS)이 이 폰의 푸시 주소를 읽어 서버에 등록할 수 있게 한다. 아직 못 받았으면 빈 문자열
    public class PushBridge {
        @JavascriptInterface
        public String getToken() {
            return getSharedPreferences(PushService.PREFS, MODE_PRIVATE).getString(PushService.KEY_TOKEN, "");
        }
    }

    // Pro 앱인지 웹 화면이 알 수 있게 한다(도면 위 내 위치 버튼을 보여 줄지)
    public class ProBridge {
        @JavascriptInterface
        public boolean isPro() {
            return BuildConfig.IS_PRO;
        }
    }

    // 웹 화면이 이 APK의 판 번호를 알 수 있게 한다(새 APK가 나오면 화면에서 안내). 1.27 이전 APK에는 이 기능이 없다
    public class AppBridge {
        @JavascriptInterface
        public int version() {
            return BuildConfig.VERSION_CODE;
        }
    }

    public class GalleryBridge {
        // 갤러리 계측사진/<siteFolder>/ 에 JPG 저장. 같은 이름이 있으면 덮어쓴다
        @JavascriptInterface
        public boolean savePhoto(String base64, String siteFolder, String fileName) {
            try {
                return writeImage(Base64.decode(base64, Base64.DEFAULT), siteFolder, fileName);
            } catch (Exception e) {
                return false;
            }
        }

        // 이 앱이 계측사진/<siteFolder>/ 에 저장한 그림 하나를 지운다. 없거나 못 지우면 false
        @JavascriptInterface
        public boolean deletePhoto(String siteFolder, String fileName) {
            try {
                return deleteImage(siteFolder, fileName);
            } catch (Exception e) {
                return false;
            }
        }
    }
}
