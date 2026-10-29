// 알림 중계 서버(Cloudflare Worker) 주소. 배포한 뒤 채운다. 비워 두면 알림 기능은 꺼진 채로 앱이 그대로 동작한다.
const PUSH_URL = 'https://gyecheuk-push.gyecheuk-push.workers.dev';
// 접속 코드가 없으면 아무 데이터도 읽거나 쓸 수 없으므로 이 주소는 공개돼도 됩니다.
// 직원 폰에 깔린 앱(APK)이 이 판 번호보다 낮으면 정보 탭에 새 앱 설치 안내를 띄운다. 새 APK를 배포할 때 android/app/build.gradle의 versionCode와 같이 올린다
const LATEST_APK = 28;
const API_URL ='https://script.google.com/macros/s/AKfycbyBN3orbfqcmmava2HkYEks2c4bm2Xs46a6bJ2hk9jjPtrdiObksxYxLfdywgQCdKr1Bg/exec';
