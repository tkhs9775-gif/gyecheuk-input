package com.kiwoomenc.gyecheuk;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.google.firebase.messaging.FirebaseMessaging;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_CAMERA_PERM = 1002;
    private static final int REQ_NOTIFY_PERM = 1003;
    private static final int REQ_CAMERA = 1004;
    private static final int REQ_LOCATION_PERM = 1005;
    private static final int MAX_BURST = 50;   // 웹 화면·서버의 사진 한도(MAX_PHOTOS)와 같다
    // 직원용/감독판 APK마다 시작 화면이 다르다 (app/build.gradle 의 productFlavors)
    private static final String LIVE_URL = BuildConfig.LIVE_URL;
    private static final String LOCAL_URL = BuildConfig.LOCAL_URL;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraPhotoUri;
    private WebChromeClient.FileChooserParams pendingChooserParams;
    private final ArrayList<Uri> burstShots = new ArrayList<>();   // 연속 촬영으로 지금까지 찍은 사진
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new GalleryBridge(), "AndroidGallery");
        webView.addJavascriptInterface(new PushBridge(), "AndroidPush");
        if (BuildConfig.IS_PRO) {
            s.setGeolocationEnabled(true);
            webView.addJavascriptInterface(new ProBridge(), "AndroidPro");
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY_PERM);
        }
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t ->
            getSharedPreferences(PushService.PREFS, MODE_PRIVATE).edit().putString(PushService.KEY_TOKEN, t).apply());

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(LIVE_URL)) {
                    view.loadUrl(LOCAL_URL);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("확인", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
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
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
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

        if (isOnline()) {
            webView.loadUrl(LIVE_URL);
        } else {
            webView.loadUrl(LOCAL_URL);
        }
    }

    private boolean isOnline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm != null ? cm.getActiveNetworkInfo() : null;
            return ni != null && ni.isConnected();
        } catch (Exception e) {
            return true;
        }
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
    // ponytail: 촬영 중 휴대폰 메모리가 모자라 이 앱이 닫히면 웹 쪽 대기가 사라져 찍은 사진이 넘어가지 않는다(파일은 앱 캐시에 남음). 실제로 생기면 찍을 때마다 갤러리에도 저장한다
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
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private Intent createCameraIntent() {
        try {
            File photoFile = new File(getCacheDir(), "shot_" + System.currentTimeMillis() + ".jpg");
            cameraPhotoUri = PhotoFileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return intent;
        } catch (Exception e) {
            cameraPhotoUri = null;
            return null;
        }
    }

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

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

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

    public class GalleryBridge {
        @JavascriptInterface
        public boolean savePhoto(String base64, String siteFolder, String fileName) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeFolder = (siteFolder == null || siteFolder.trim().isEmpty()) ? "현장무관" : siteFolder.trim();
                String relPath = Environment.DIRECTORY_PICTURES + "/계측사진/" + safeFolder;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContentResolver();
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
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "계측사진/" + safeFolder);
                    if (!dir.exists()) dir.mkdirs();
                    File file = new File(dir, fileName);
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        fos.write(bytes);
                    }
                    MediaScannerConnection.scanFile(MainActivity.this, new String[]{file.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
                    return true;
                }
            } catch (Exception e) {
                return false;
            }
        }
    }
}
