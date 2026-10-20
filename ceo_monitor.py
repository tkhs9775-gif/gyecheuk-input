import os
import sys
import json
import base64
import threading
import urllib.request
import urllib.error
import webbrowser
from datetime import datetime, timedelta
from collections import defaultdict
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

# ==============================================================================
# 기본 설정 (직원용 앱 config.js 및 Code.gs 연동 정보)
# ==============================================================================
DEFAULT_API_URL = "https://script.google.com/macros/s/AKfycbyBN3orbfqcmmava2HkYEks2c4bm2Xs46a6bJ2hk9jjPtrdiObksxYxLfdywgQCdKr1Bg/exec"
APP_TITLE = "(주)키움이엔씨 현장 계측 통합 관제 시스템 [대표님 전용 감독판]"
APP_VERSION = "v2.0 Director's Cut (Stealth Read-Only)"
CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".kiwoom_ceo_monitor.json")

# Code.gs 의 기록 시트 열 인덱스 (COL)
COL = {
    "time": 0,      # 저장시각 (yyyy-MM-dd HH:mm:ss)
    "clientId": 1,  # 클라이언트ID
    "site": 2,      # 현장
    "user": 3,      # 측정자
    "id": 4,        # 계측기ID
    "type": 5,      # 종류
    "place": 6,     # 위치
    "value": 7,     # 값
    "unit": 8,      # 단위
    "prev": 9,      # 전회값
    "delta": 10,    # 변화량
    "memo": 11,     # 메모
    "link": 12,     # 사진링크
    "date": 13,     # 측정일 (yyyy-MM-dd)
    "value2": 14,   # 값2
    "value3": 15,   # 값3
    "prev2": 16,    # 전회값2
    "prev3": 17,    # 전회값3
    "delta2": 18,   # 변화량2
    "delta3": 19,   # 변화량3
    "status": 20,   # 상태 (삭제 / 파손 / 망실 / 접근 불가 / 작동 불량)
    "history": 21,  # 수정이력
    "weather": 22,  # 날씨
}


def safe_get(row, idx):
    return str(row[idx]).strip() if idx < len(row) and row[idx] is not None else ""


def parse_dt(s):
    try:
        return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


class CEOMonitorApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1440x880")
        self.minsize(1200, 740)
        self.configure(bg="#0F172A")

        # 상태 데이터
        self.saved_cfg = self.load_local_config()
        self.api_url = self.saved_cfg.get("api_url", DEFAULT_API_URL)
        self.access_code = self.saved_cfg.get("code", "")
        self.auto_refresh_sec = 60
        self.auto_refresh_job = None
        self.is_loading = False

        # 서버 동기화 원본 데이터
        self.sync_data = {
            "sites": [],
            "names": [],
            "types": [],
            "instruments": [],
            "records": [],
            "issues": [],
            "photos": [],
            "surveys": [],
            "drawingNotes": [],
            "drive": {"photos": [], "surveys": [], "drawings": []},
        }

        self.setup_styles()
        self.build_header()
        self.build_kpi_bar()
        self.build_Main_tabs()
        self.build_statusbar()

        if self.access_code:
            self.after(300, lambda: self.sync_from_server(include_drive=True))
        else:
            self.after(300, self.open_login_dialog)

    # --------------------------------------------------------------------------
    # 로컬 설정 저장/불러오기
    # --------------------------------------------------------------------------
    def load_local_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    def save_local_config(self):
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump({"api_url": self.api_url, "code": self.access_code}, f, ensure_ascii=False)
        except Exception:
            pass

    # --------------------------------------------------------------------------
    # 스타일 설정
    # --------------------------------------------------------------------------
    def setup_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")

        style.configure("TNotebook", background="#0F172A", borderwidth=0)
        style.configure(
            "TNotebook.Tab",
            background="#1E293B",
            foreground="#94A3B8",
            padding=[18, 10],
            font=("맑은 고딕", 10, "bold"),
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", "#2563EB")],
            foreground=[("selected", "#FFFFFF")],
        )

        style.configure(
            "Treeview",
            background="#1E293B",
            foreground="#F8FAFC",
            fieldbackground="#1E293B",
            rowheight=28,
            font=("맑은 고딕", 9),
            borderwidth=0,
        )
        style.configure(
            "Treeview.Heading",
            background="#334155",
            foreground="#F8FAFC",
            font=("맑은 고딕", 9, "bold"),
            relief="flat",
        )
        style.map("Treeview", background=[("selected", "#2563EB")], foreground=[("selected", "#FFFFFF")])

    # --------------------------------------------------------------------------
    # 상단 헤더 & KPI 카드 바
    # --------------------------------------------------------------------------
    def build_header(self):
        hdr = tk.Frame(self, bg="#0F172A", pady=12, padx=18)
        hdr.pack(fill="x")

        title_box = tk.Frame(hdr, bg="#0F172A")
        title_box.pack(side="left")

        tk.Label(
            title_box,
            text="🔒 KIWOOM E&C · CEO STEALTH MONITOR",
            bg="#0F172A",
            fg="#38BDF8",
            font=("맑은 고딕", 9, "bold"),
        ).pack(anchor="w")
        tk.Label(
            title_box,
            text="(주)키움이엔씨 실시간 현장·직원 근태 및 계측 감독 시스템",
            bg="#0F172A",
            fg="#F8FAFC",
            font=("맑은 고딕", 16, "bold"),
        ).pack(anchor="w")

        ctrl_box = tk.Frame(hdr, bg="#0F172A")
        ctrl_box.pack(side="right")

        # 기준 날짜 필터
        tk.Label(ctrl_box, text="조회 기준일:", bg="#0F172A", fg="#CBD5E1", font=("맑은 고딕", 9)).pack(side="left", padx=(0, 4))
        self.date_var = tk.StringVar(value=datetime.now().strftime("%Y-%m-%d"))
        self.date_entry = tk.Entry(
            ctrl_box, textvariable=self.date_var, width=12, bg="#1E293B", fg="#F8FAFC",
            insertbackground="#F8FAFC", relief="flat", font=("맑은 고딕", 10, "bold"), justify="center"
        )
        self.date_entry.pack(side="left", padx=(0, 8), ipady=4)

        tk.Button(
            ctrl_box, text="오늘", command=self.set_today,
            bg="#334155", fg="#F8FAFC", relief="flat", padx=8, pady=4, font=("맑은 고딕", 9)
        ).pack(side="left", padx=(0, 8))

        tk.Button(
            ctrl_box, text="적용/필터", command=self.refresh_all_views,
            bg="#0284C7", fg="#FFFFFF", relief="flat", padx=10, pady=4, font=("맑은 고딕", 9, "bold")
        ).pack(side="left", padx=(0, 14))

        # 자동 새로고침 체크박스
        self.auto_var = tk.BooleanVar(value=True)
        tk.Checkbutton(
            ctrl_box, text="1분 자동갱신", variable=self.auto_var, command=self.toggle_auto_refresh,
            bg="#0F172A", fg="#94A3B8", selectcolor="#1E293B", activebackground="#0F172A",
            font=("맑은 고딕", 9)
        ).pack(side="left", padx=(0, 12))

        self.btn_sync = tk.Button(
            ctrl_box, text="🔄 지금 서버 동기화", command=lambda: self.sync_from_server(include_drive=True),
            bg="#2563EB", fg="#FFFFFF", relief="flat", padx=14, pady=6, font=("맑은 고딕", 10, "bold")
        )
        self.btn_sync.pack(side="left", padx=(0, 8))

        tk.Button(
            ctrl_box, text="⚙ 접속코드 설정", command=self.open_login_dialog,
            bg="#334155", fg="#E2E8F0", relief="flat", padx=10, pady=6, font=("맑은 고딕", 9)
        ).pack(side="left")

    def build_kpi_bar(self):
        bar = tk.Frame(self, bg="#0F172A", padx=18, pady=4)
        bar.pack(fill="x")

        self.kpi_vars = {}
        kpi_specs = [
            ("today_count", "오늘 실시간 입력 건수", "0건", "#38BDF8"),
            ("active_users", "오늘 활동 직원 / 총원", "0 / 0명", "#4ADE80"),
            ("site_coverage", "오늘 가동 현장 / 전체", "0 / 0곳", "#A78BFA"),
            ("suspect_count", "몰아치기·지연입력 의심", "0건", "#FBBF24"),
            ("issue_count", "현장 이상보고 / 수정·삭제", "0 / 0건", "#F87171"),
        ]

        for idx, (key, label, default_val, color) in enumerate(kpi_specs):
            card = tk.Frame(bar, bg="#1E293B", padx=16, pady=12, highlightbackground="#334155", highlightthickness=1)
            card.pack(side="left", fill="both", expand=True, padx=(0 if idx == 0 else 8, 0))

            tk.Label(card, text=label, bg="#1E293B", fg="#94A3B8", font=("맑은 고딕", 9)).pack(anchor="w")
            v = tk.StringVar(value=default_val)
            self.kpi_vars[key] = v
            tk.Label(card, textvariable=v, bg="#1E293B", fg=color, font=("맑은 고딕", 18, "bold")).pack(anchor="w", pady=(4, 0))

    # --------------------------------------------------------------------------
    # 메인 탭 화면 구성
    # --------------------------------------------------------------------------
    def build_Main_tabs(self):
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=18, pady=10)

        self.tab_staff = tk.Frame(self.notebook, bg="#0F172A")
        self.tab_live = tk.Frame(self.notebook, bg="#0F172A")
        self.tab_sites = tk.Frame(self.notebook, bg="#0F172A")
        self.tab_audit = tk.Frame(self.notebook, bg="#0F172A")
        self.tab_drive = tk.Frame(self.notebook, bg="#0F172A")

        self.notebook.add(self.tab_staff, text=" 🕵️ 1. 직원별 성실도·근태 정밀 분석 ")
        self.notebook.add(self.tab_live, text=" ⚡ 2. 실시간 입력 피드 & 전체 기록 ")
        self.notebook.add(self.tab_sites, text=" 🏗️ 3. 현장별 계측 달성률 & 미측정 색출 ")
        self.notebook.add(self.tab_audit, text=" 🚨 4. 수정/삭제 뒷조사 & 이상보고 ")
        self.notebook.add(self.tab_drive, text=" 📁 5. 현장 사진 · 측량 · 도면야장 열람 ")

        self.init_tab_staff()
        self.init_tab_live()
        self.init_tab_sites()
        self.init_tab_audit()
        self.init_tab_drive()

    def build_statusbar(self):
        bar = tk.Frame(self, bg="#1E293B", pady=6, padx=18)
        bar.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="보안 접속 코드를 입력해 클라우드와 연결하세요. (스텔스 읽기 전용 모드)")
        tk.Label(bar, textvariable=self.status_var, bg="#1E293B", fg="#CBD5E1", font=("맑은 고딕", 9)).pack(side="left")
        tk.Label(bar, text=APP_VERSION, bg="#1E293B", fg="#64748B", font=("맑은 고딕", 9)).pack(side="right")

    # --------------------------------------------------------------------------
    # 탭 1: 직원별 성실도·근태 정밀 분석
    # --------------------------------------------------------------------------
    def init_tab_staff(self):
        top_info = tk.Frame(self.tab_staff, bg="#0F172A", pady=8)
        top_info.pack(fill="x")
        tk.Label(
            top_info,
            text="💡 [판독 기준]  • 몰아치기 의심: 이전 입력 후 60초 이내에 연속 입력한 건수   • 지연(소급) 입력: 측정일과 실제 서버 저장일이 다른 건수   • 직원을 클릭하면 아래에 타임라인이 표시됩니다.",
            bg="#0F172A", fg="#94A3B8", font=("맑은 고딕", 9)
        ).pack(side="left", padx=8)

        paned = tk.PanedWindow(self.tab_staff, orient="vertical", bg="#0F172A", sashwidth=6, bd=0)
        paned.pack(fill="both", expand=True)

        # 상단: 직원별 요약 표
        upper = tk.Frame(paned, bg="#0F172A")
        cols = ("user", "today_cnt", "total_cnt", "sites", "first_time", "last_time", "work_span", "burst_cnt", "late_cnt", "edit_cnt", "score", "verdict")
        self.tree_staff = ttk.Treeview(upper, columns=cols, show="headings", height=10)
        headers = {
            "user": ("직원명", 100),
            "today_cnt": ("기준일 입력", 90),
            "total_cnt": ("누적 입력", 90),
            "sites": ("담당 현장(기준일)", 220),
            "first_time": ("첫 입력 시각", 100),
            "last_time": ("마지막 입력", 100),
            "work_span": ("현장 체류(활동)시간", 130),
            "burst_cnt": ("몰아치기(1분내)", 110),
            "late_cnt": ("소급(뒷북)입력", 110),
            "edit_cnt": ("수정/삭제", 85),
            "score": ("성실도 점수", 95),
            "verdict": ("AI 종합 근태 판정", 220),
        }
        for c, (txt, w) in headers.items():
            self.tree_staff.heading(c, text=txt)
            self.tree_staff.column(c, width=w, anchor="center" if c not in ("sites", "verdict") else "w")

        self.tree_staff.tag_configure("good", foreground="#4ADE80")
        self.tree_staff.tag_configure("warn", foreground="#FBBF24")
        self.tree_staff.tag_configure("bad", foreground="#F87171")
        self.tree_staff.tag_configure("inactive", foreground="#64748B")

        sb1 = ttk.Scrollbar(upper, orient="vertical", command=self.tree_staff.yview)
        self.tree_staff.configure(yscrollcommand=sb1.set)
        self.tree_staff.pack(side="left", fill="both", expand=True)
        sb1.pack(side="right", fill="y")
        self.tree_staff.bind("<<TreeviewSelect>>", self.on_select_staff)
        paned.add(upper)

        # 하단: 선택한 직원의 시간순 입력 간격 분석
        lower = tk.Frame(paned, bg="#0F172A")
        lbl_frame = tk.Frame(lower, bg="#0F172A", pady=4)
        lbl_frame.pack(fill="x")
        self.staff_detail_label = tk.Label(
            lbl_frame, text="▼ 위 표에서 직원을 선택하면 시간대별 상세 입력 간격과 몰아치기/소급입력 여부가 표시됩니다.",
            bg="#0F172A", fg="#38BDF8", font=("맑은 고딕", 10, "bold")
        )
        self.staff_detail_label.pack(side="left", padx=6)

        dcols = ("save_time", "gap", "meas_date", "site", "inst_id", "type", "val", "delta", "weather", "flag", "memo")
        self.tree_staff_detail = ttk.Treeview(lower, columns=dcols, show="headings", height=9)
        dheaders = {
            "save_time": ("실제 전송시각", 145),
            "gap": ("직전 입력과의 간격", 120),
            "meas_date": ("입력한 측정일", 100),
            "site": ("현장명", 160),
            "inst_id": ("계측기ID", 110),
            "type": ("종류", 100),
            "val": ("측정값", 110),
            "delta": ("변화량", 95),
            "weather": ("당시 날씨", 160),
            "flag": ("근태 판독", 140),
            "memo": ("메모 / 수정이력", 200),
        }
        for c, (txt, w) in dheaders.items():
            self.tree_staff_detail.heading(c, text=txt)
            self.tree_staff_detail.column(c, width=w, anchor="center" if c not in ("site", "weather", "memo") else "w")

        self.tree_staff_detail.tag_configure("flag_warn", foreground="#FBBF24")
        self.tree_staff_detail.tag_configure("flag_bad", foreground="#F87171")
        self.tree_staff_detail.tag_configure("normal", foreground="#E2E8F0")

        sb2 = ttk.Scrollbar(lower, orient="vertical", command=self.tree_staff_detail.yview)
        self.tree_staff_detail.configure(yscrollcommand=sb2.set)
        self.tree_staff_detail.pack(side="left", fill="both", expand=True)
        sb2.pack(side="right", fill="y")
        paned.add(lower)

    # --------------------------------------------------------------------------
    # 탭 2: 실시간 입력 피드 & 전체 기록 검색/엑셀 저장
    # --------------------------------------------------------------------------
    def init_tab_live(self):
        fbar = tk.Frame(self.tab_live, bg="#0F172A", pady=8)
        fbar.pack(fill="x")

        tk.Label(fbar, text="현장:", bg="#0F172A", fg="#CBD5E1", font=("맑은 고딕", 9)).pack(side="left", padx=(6, 4))
        self.filter_site_var = tk.StringVar(value="전체")
        self.cb_site = ttk.Combobox(fbar, textvariable=self.filter_site_var, state="readonly", width=22)
        self.cb_site.pack(side="left", padx=(0, 12))
        self.cb_site.bind("<<ComboboxSelected>>", lambda e: self.populate_live_feed())

        tk.Label(fbar, text="직원:", bg="#0F172A", fg="#CBD5E1", font=("맑은 고딕", 9)).pack(side="left", padx=(0, 4))
        self.filter_user_var = tk.StringVar(value="전체")
        self.cb_user = ttk.Combobox(fbar, textvariable=self.filter_user_var, state="readonly", width=14)
        self.cb_user.pack(side="left", padx=(0, 12))
        self.cb_user.bind("<<ComboboxSelected>>", lambda e: self.populate_live_feed())

        tk.Label(fbar, text="검색어(ID/메모):", bg="#0F172A", fg="#CBD5E1", font=("맑은 고딕", 9)).pack(side="left", padx=(0, 4))
        self.search_var = tk.StringVar()
        ent = tk.Entry(fbar, textvariable=self.search_var, width=20, bg="#1E293B", fg="#F8FAFC", insertbackground="#F8FAFC", relief="flat")
        ent.pack(side="left", padx=(0, 8), ipady=3)
        ent.bind("<Return>", lambda e: self.populate_live_feed())

        tk.Button(
            fbar, text="🔍 검색", command=self.populate_live_feed,
            bg="#2563EB", fg="#FFFFFF", relief="flat", padx=10, pady=3, font=("맑은 고딕", 9, "bold")
        ).pack(side="left", padx=(0, 8))

        tk.Button(
            fbar, text="📥 현재 목록 CSV(엑셀) 다운로드", command=self.export_live_csv,
            bg="#059669", fg="#FFFFFF", relief="flat", padx=12, pady=3, font=("맑은 고딕", 9, "bold")
        ).pack(side="right", padx=6)

        cols = ("time", "date", "site", "user", "id", "type", "place", "val", "prev", "delta", "status", "weather", "photo", "memo")
        self.tree_live = ttk.Treeview(self.tab_live, columns=cols, show="headings")
        headers = {
            "time": ("저장시각", 145),
            "date": ("측정일", 90),
            "site": ("현장", 160),
            "user": ("측정자", 85),
            "id": ("계측기ID", 105),
            "type": ("종류", 95),
            "place": ("위치", 120),
            "val": ("측정값", 110),
            "prev": ("전회값", 100),
            "delta": ("변화량", 95),
            "status": ("상태", 80),
            "weather": ("날씨", 150),
            "photo": ("사진", 65),
            "memo": ("메모", 180),
        }
        for c, (txt, w) in headers.items():
            self.tree_live.heading(c, text=txt)
            self.tree_live.column(c, width=w, anchor="center" if c not in ("site", "place", "weather", "memo") else "w")

        self.tree_live.tag_configure("deleted", foreground="#64748B")
        self.tree_live.tag_configure("issue", foreground="#F87171")
        self.tree_live.tag_configure("edited", foreground="#FBBF24")

        sb = ttk.Scrollbar(self.tab_live, orient="vertical", command=self.tree_live.yview)
        self.tree_live.configure(yscrollcommand=sb.set)
        self.tree_live.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.tree_live.bind("<Double-1>", self.on_double_click_live)

    # --------------------------------------------------------------------------
    # 탭 3: 현장별 계측 달성률 & 미측정 계측기 색출
    # --------------------------------------------------------------------------
    def init_tab_sites(self):
        paned = tk.PanedWindow(self.tab_sites, orient="horizontal", bg="#0F172A", sashwidth=6, bd=0)
        paned.pack(fill="both", expand=True, pady=6)

        left = tk.Frame(paned, bg="#0F172A")
        tk.Label(left, text="📊 현장별 기준일 계측 진행률 (클릭 시 우측에 미측정 계측기 표시)", bg="#0F172A", fg="#38BDF8", font=("맑은 고딕", 10, "bold")).pack(anchor="w", padx=6, pady=4)

        scols = ("site", "total_inst", "done_inst", "missing_inst", "rate", "workers", "last_update")
        self.tree_sites = ttk.Treeview(left, columns=scols, show="headings")
        sheaders = {
            "site": ("현장명", 190),
            "total_inst": ("등록 계측기", 85),
            "done_inst": ("측정 완료", 85),
            "missing_inst": ("미측정(누락)", 90),
            "rate": ("달성률", 80),
            "workers": ("투입 직원", 130),
            "last_update": ("최근 입력 시각", 140),
        }
        for c, (txt, w) in sheaders.items():
            self.tree_sites.heading(c, text=txt)
            self.tree_sites.column(c, width=w, anchor="center" if c not in ("site", "workers") else "w")

        self.tree_sites.tag_configure("complete", foreground="#4ADE80")
        self.tree_sites.tag_configure("partial", foreground="#FBBF24")
        self.tree_sites.tag_configure("zero", foreground="#F87171")

        sb1 = ttk.Scrollbar(left, orient="vertical", command=self.tree_sites.yview)
        self.tree_sites.configure(yscrollcommand=sb1.set)
        self.tree_sites.pack(side="left", fill="both", expand=True)
        sb1.pack(side="right", fill="y")
        self.tree_sites.bind("<<TreeviewSelect>>", self.on_select_site_coverage)
        paned.add(left)

        right = tk.Frame(paned, bg="#0F172A")
        self.site_inst_label = tk.Label(right, text="🔍 선택한 현장의 계측기별 측정 여부 및 누락 점검", bg="#0F172A", fg="#FBBF24", font=("맑은 고딕", 10, "bold"))
        self.site_inst_label.pack(anchor="w", padx=6, pady=4)

        icols = ("state", "id", "type", "place", "user", "val", "time")
        self.tree_site_inst = ttk.Treeview(right, columns=icols, show="headings")
        iheaders = {
            "state": ("점검 상태", 95),
            "id": ("계측기ID", 105),
            "type": ("종류", 95),
            "place": ("위치", 120),
            "user": ("측정자", 80),
            "val": ("기준일 측정값", 110),
            "time": ("저장시각", 140),
        }
        for c, (txt, w) in iheaders.items():
            self.tree_site_inst.heading(c, text=txt)
            self.tree_site_inst.column(c, width=w, anchor="center" if c != "place" else "w")

        self.tree_site_inst.tag_configure("missing", foreground="#F87171")
        self.tree_site_inst.tag_configure("done", foreground="#4ADE80")
        self.tree_site_inst.tag_configure("issue", foreground="#FBBF24")

        sb2 = ttk.Scrollbar(right, orient="vertical", command=self.tree_site_inst.yview)
        self.tree_site_inst.configure(yscrollcommand=sb2.set)
        self.tree_site_inst.pack(side="left", fill="both", expand=True)
        sb2.pack(side="right", fill="y")
        paned.add(right)

    # --------------------------------------------------------------------------
    # 탭 4: 수정/삭제 이력 뒷조사 & 현장 이상보고
    # --------------------------------------------------------------------------
    def init_tab_audit(self):
        paned = tk.PanedWindow(self.tab_audit, orient="vertical", bg="#0F172A", sashwidth=6, bd=0)
        paned.pack(fill="both", expand=True, pady=6)

        upper = tk.Frame(paned, bg="#0F172A")
        tk.Label(upper, text="🕵️ 직원 데이터 수정 및 삭제 흔적 추적 (수정이력 및 삭제 상태 기록 전체)", bg="#0F172A", fg="#FBBF24", font=("맑은 고딕", 10, "bold")).pack(anchor="w", padx=6, pady=4)

        acols = ("time", "site", "user", "id", "type", "val", "status", "history", "memo")
        self.tree_audit = ttk.Treeview(upper, columns=acols, show="headings", height=9)
        aheaders = {
            "time": ("최초 저장시각", 145),
            "site": ("현장", 160),
            "user": ("측정자", 90),
            "id": ("계측기ID", 110),
            "type": ("종류", 100),
            "val": ("현재 값", 110),
            "status": ("현재 상태", 90),
            "history": ("상세 수정·삭제 이력 (과거값 → 변경값)", 380),
            "memo": ("메모", 180),
        }
        for c, (txt, w) in aheaders.items():
            self.tree_audit.heading(c, text=txt)
            self.tree_audit.column(c, width=w, anchor="center" if c not in ("site", "history", "memo") else "w")

        sb1 = ttk.Scrollbar(upper, orient="vertical", command=self.tree_audit.yview)
        self.tree_audit.configure(yscrollcommand=sb1.set)
        self.tree_audit.pack(side="left", fill="both", expand=True)
        sb1.pack(side="right", fill="y")
        paned.add(upper)

        lower = tk.Frame(paned, bg="#0F172A")
        tk.Label(lower, text="🚨 현장 계측기 이상보고 접수 내역 (파손 / 망실 / 접근 불가 / 작동 불량)", bg="#0F172A", fg="#F87171", font=("맑은 고딕", 10, "bold")).pack(anchor="w", padx=6, pady=4)

        icols = ("time", "date", "site", "user", "id", "type", "place", "issue", "memo", "link")
        self.tree_issues = ttk.Treeview(lower, columns=icols, show="headings", height=9)
        iheaders = {
            "time": ("보고시각", 145),
            "date": ("측정일", 95),
            "site": ("현장", 160),
            "user": ("보고자", 90),
            "id": ("계측기ID", 110),
            "type": ("종류", 100),
            "place": ("위치", 130),
            "issue": ("이상 상태", 100),
            "memo": ("상세 사유 메모", 260),
            "link": ("사진 링크(더블클릭)", 150),
        }
        for c, (txt, w) in iheaders.items():
            self.tree_issues.heading(c, text=txt)
            self.tree_issues.column(c, width=w, anchor="center" if c not in ("site", "place", "memo", "link") else "w")

        sb2 = ttk.Scrollbar(lower, orient="vertical", command=self.tree_issues.yview)
        self.tree_issues.configure(yscrollcommand=sb2.set)
        self.tree_issues.pack(side="left", fill="both", expand=True)
        sb2.pack(side="right", fill="y")
        self.tree_issues.bind("<Double-1>", self.on_double_click_issue)
        paned.add(lower)

    # --------------------------------------------------------------------------
    # 탭 5: 구글 드라이브 (현장사진 / 측량파일 / 도면야장) 무로그인 탐색기
    # --------------------------------------------------------------------------
    def init_tab_drive(self):
        top_bar = tk.Frame(self.tab_drive, bg="#0F172A", pady=8)
        top_bar.pack(fill="x")

        tk.Label(
            top_bar,
            text="📂 구글 계정 로그인 없이 클라우드의 [계측사진], [측량파일(GPS/QGIS)], [도면(PDF) 및 야장 필기]를 PC로 즉시 내려받거나 열람합니다.",
            bg="#0F172A", fg="#94A3B8", font=("맑은 고딕", 9)
        ).pack(side="left", padx=6)

        tk.Button(
            top_bar, text="⬇ 선택한 파일 PC로 다운로드 및 열기", command=self.download_selected_drive_file,
            bg="#2563EB", fg="#FFFFFF", relief="flat", padx=14, pady=4, font=("맑은 고딕", 9, "bold")
        ).pack(side="right", padx=6)

        tk.Button(
            top_bar, text="🌐 웹브라우저로 링크 열기", command=self.open_selected_drive_url,
            bg="#334155", fg="#FFFFFF", relief="flat", padx=12, pady=4, font=("맑은 고딕", 9)
        ).pack(side="right", padx=6)

        paned = tk.PanedWindow(self.tab_drive, orient="vertical", bg="#0F172A", sashwidth=6, bd=0)
        paned.pack(fill="both", expand=True)

        upper = tk.Frame(paned, bg="#0F172A")
        dcols = ("category", "site", "name", "updated", "size", "file_id", "url")
        self.tree_drive = ttk.Treeview(upper, columns=dcols, show="headings", height=11)
        dheaders = {
            "category": ("분류", 130),
            "site": ("현장명", 180),
            "name": ("파일명", 320),
            "updated": ("최근 수정시각", 140),
            "size": ("크기", 90),
            "file_id": ("Drive 파일 ID", 220),
            "url": ("클라우드 링크", 240),
        }
        for c, (txt, w) in dheaders.items():
            self.tree_drive.heading(c, text=txt)
            self.tree_drive.column(c, width=w, anchor="center" if c not in ("site", "name", "url") else "w")

        sb1 = ttk.Scrollbar(upper, orient="vertical", command=self.tree_drive.yview)
        self.tree_drive.configure(yscrollcommand=sb1.set)
        self.tree_drive.pack(side="left", fill="both", expand=True)
        sb1.pack(side="right", fill="y")
        self.tree_drive.bind("<Double-1>", lambda e: self.download_selected_drive_file())
        paned.add(upper)

        # 하단: 도면야장(동그라미 메모 + 필기) 내역
        lower = tk.Frame(paned, bg="#0F172A")
        tk.Label(lower, text="📝 현장 도면(PDF) 야장 메모 & 펜 필기 작성 현황 (직원이 도면 위에 찍은 동그라미 OCR 메모)", bg="#0F172A", fg="#38BDF8", font=("맑은 고딕", 10, "bold")).pack(anchor="w", padx=6, pady=4)

        ncols = ("updated", "site", "file_name", "user", "pin_count", "pin_texts")
        self.tree_notes = ttk.Treeview(lower, columns=ncols, show="headings", height=7)
        nheaders = {
            "updated": ("수정시각", 145),
            "site": ("현장명", 170),
            "file_name": ("도면 파일명", 240),
            "user": ("작성 직원", 95),
            "pin_count": ("마커/필기 수", 110),
            "pin_texts": ("도면에 기입된 동그라미 메모 내용 요약", 540),
        }
        for c, (txt, w) in nheaders.items():
            self.tree_notes.heading(c, text=txt)
            self.tree_notes.column(c, width=w, anchor="center" if c not in ("site", "file_name", "pin_texts") else "w")

        sb2 = ttk.Scrollbar(lower, orient="vertical", command=self.tree_notes.yview)
        self.tree_notes.configure(yscrollcommand=sb2.set)
        self.tree_notes.pack(side="left", fill="both", expand=True)
        sb2.pack(side="right", fill="y")
        paned.add(lower)

    # --------------------------------------------------------------------------
    # 서버 API 통신 (Code.gs의 pc_sync, drive_download 호출)
    # --------------------------------------------------------------------------
    def call_api(self, action, payload=None):
        body = {"code": self.access_code, "action": action}
        if payload:
            body.update(payload)
        data_bytes = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.api_url,
            data=data_bytes,
            headers={"Content-Type": "text/plain;charset=utf-8"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)

    def sync_from_server(self, include_drive=True):
        if self.is_loading:
            return
        if not self.access_code:
            self.open_login_dialog()
            return

        self.is_loading = True
        self.btn_sync.configure(state="disabled", text="⏳ 동기화 중...")
        self.status_var.set("클라우드 서버에서 전체 현장 데이터 및 직원 활동 로그를 은밀하게 수집 중입니다...")

        def worker():
            try:
                res = self.call_api("pc_sync", {"limit": 5000, "includeDrive": include_drive})
                self.after(0, lambda: self.on_sync_success(res))
            except Exception as e:
                self.after(0, lambda: self.on_sync_error(str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def on_sync_success(self, res):
        self.is_loading = False
        self.btn_sync.configure(state="normal", text="🔄 지금 서버 동기화")

        if not res.get("ok"):
            err = res.get("error", "unknown")
            msg = {
                "bad_code": "보안 접속 코드가 일치하지 않습니다.",
                "locked": "비밀번호 오류 횟수 초과로 10분간 잠겼습니다.",
            }.get(err, f"서버 오류: {err}")
            self.status_var.set(f"동기화 실패: {msg}")
            messagebox.showerror("접속 오류", msg)
            if err == "bad_code":
                self.open_login_dialog()
            return

        self.sync_data["sites"] = res.get("sites", [])
        self.sync_data["names"] = res.get("names", [])
        self.sync_data["types"] = res.get("types", [])
        self.sync_data["instruments"] = res.get("instruments", [])
        self.sync_data["records"] = res.get("records", [])
        self.sync_data["issues"] = res.get("issues", [])
        self.sync_data["photos"] = res.get("photos", [])
        self.sync_data["surveys"] = res.get("surveys", [])
        self.sync_data["drawingNotes"] = res.get("drawingNotes", [])
        if res.get("drive"):
            self.sync_data["drive"] = res["drive"]

        # 필터 콤보박스 갱신
        self.cb_site["values"] = ["전체"] + self.sync_data["sites"]
        self.cb_user["values"] = ["전체"] + self.sync_data["names"]

        self.refresh_all_views()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.status_var.set(
            f"✓ 실시간 동기화 완료 ({now_str}) — 총 기록 {len(self.sync_data['records'])}건 / 직원 {len(self.sync_data['names'])}명 / 현장 {len(self.sync_data['sites'])}곳 감시 중"
        )
        self.schedule_next_refresh()

    def on_sync_error(self, err_msg):
        self.is_loading = False
        self.btn_sync.configure(state="normal", text="🔄 지금 서버 동기화")
        self.status_var.set(f"네트워크 오류: {err_msg}")
        self.schedule_next_refresh()

    def toggle_auto_refresh(self):
        self.schedule_next_refresh()

    def schedule_next_refresh(self):
        if self.auto_refresh_job:
            self.after_cancel(self.auto_refresh_job)
            self.auto_refresh_job = None
        if self.auto_var.get() and self.access_code:
            self.auto_refresh_job = self.after(self.auto_refresh_sec * 1000, lambda: self.sync_from_server(include_drive=False))

    def set_today(self):
        self.date_var.set(datetime.now().strftime("%Y-%m-%d"))
        self.refresh_all_views()

    # --------------------------------------------------------------------------
    # 데이터 분석 & 전체 화면 갱신
    # --------------------------------------------------------------------------
    def refresh_all_views(self):
        target_date = self.date_var.get().strip()
        records = self.sync_data["records"]
        names = self.sync_data["names"]
        sites = self.sync_data["sites"]

        # 유효 기록(삭제 제외)과 전체 기록 분리
        active_records = [r for r in records if safe_get(r, COL["status"]) != "삭제"]
        today_records = [
            r for r in active_records
            if safe_get(r, COL["date"]) == target_date or safe_get(r, COL["time"]).startswith(target_date)
        ]

        # 1. 직원별 성실도 분석
        self.analyze_and_populate_staff(target_date, records, names)

        # 2. 실시간 입력 피드
        self.populate_live_feed()

        # 3. 현장별 달성률 분석
        self.populate_site_coverage(target_date, active_records)

        # 4. 수정/삭제 뒷조사 및 이상보고
        edited_or_deleted = [
            r for r in records
            if safe_get(r, COL["status"]) == "삭제" or safe_get(r, COL["history"]) != ""
        ]
        self.populate_audit_and_issues(edited_or_deleted, self.sync_data["issues"])

        # 5. 드라이브 트리 및 도면야장
        self.populate_drive_and_notes()

        # KPI 업데이트
        active_workers_today = len({safe_get(r, COL["user"]) for r in today_records if safe_get(r, COL["user"])})
        active_sites_today = len({safe_get(r, COL["site"]) for r in today_records if safe_get(r, COL["site"])})

        self.kpi_vars["today_count"].set(f"{len(today_records):,}건")
        self.kpi_vars["active_users"].set(f"{active_workers_today} / {len(names)}명")
        self.kpi_vars["site_coverage"].set(f"{active_sites_today} / {len(sites)}곳")
        self.kpi_vars["issue_count"].set(f"{len(self.sync_data['issues'])} / {len(edited_or_deleted)}건")

    def analyze_and_populate_staff(self, target_date, all_records, names):
        self.tree_staff.delete(*self.tree_staff.get_children())
        self.staff_records_by_user = defaultdict(list)

        all_users = list(dict.fromkeys(names + [safe_get(r, COL["user"]) for r in all_records if safe_get(r, COL["user"])]))
        total_suspect = 0

        for user in all_users:
            u_all = [r for r in all_records if safe_get(r, COL["user"]) == user]
            u_active = [r for r in u_all if safe_get(r, COL["status"]) != "삭제"]
            u_today = [
                r for r in u_active
                if safe_get(r, COL["date"]) == target_date or safe_get(r, COL["time"]).startswith(target_date)
            ]

            # 시간순 정렬
            u_today_sorted = sorted(u_today, key=lambda r: safe_get(r, COL["time"]))
            self.staff_records_by_user[user] = u_today_sorted if u_today_sorted else sorted(u_active, key=lambda r: safe_get(r, COL["time"]))[-50:]

            today_sites = sorted({safe_get(r, COL["site"]) for r in u_today_sorted if safe_get(r, COL["site"])})
            first_t = safe_get(u_today_sorted[0], COL["time"])[11:16] if u_today_sorted else "-"
            last_t = safe_get(u_today_sorted[-1], COL["time"])[11:16] if u_today_sorted else "-"

            work_span_str = "-"
            if len(u_today_sorted) >= 2:
                dt0 = parse_dt(safe_get(u_today_sorted[0], COL["time"]))
                dt1 = parse_dt(safe_get(u_today_sorted[-1], COL["time"]))
                if dt0 and dt1:
                    mins = int((dt1 - dt0).total_seconds() // 60)
                    work_span_str = f"{mins // 60}시간 {mins % 60}분" if mins >= 60 else f"{mins}분"

            # 몰아치기(60초 이내 연속 입력) 및 소급입력(저장일 != 측정일) 계산
            burst_cnt = 0
            late_cnt = 0
            prev_dt = None
            for r in u_today_sorted:
                cur_dt = parse_dt(safe_get(r, COL["time"]))
                save_ymd = safe_get(r, COL["time"])[:10]
                meas_ymd = safe_get(r, COL["date"])[:10]
                if save_ymd and meas_ymd and save_ymd != meas_ymd:
                    late_cnt += 1
                if prev_dt and cur_dt:
                    gap_sec = (cur_dt - prev_dt).total_seconds()
                    if 0 <= gap_sec <= 60:
                        burst_cnt += 1
                prev_dt = cur_dt

            edit_cnt = sum(1 for r in u_all if safe_get(r, COL["status"]) == "삭제" or safe_get(r, COL["history"]) != "")
            total_suspect += (burst_cnt + late_cnt)

            # 성실도 점수 및 판정
            if not u_today_sorted:
                score_str = "-"
                verdict = "기준일 입력 없음 (미활동/휴무)"
                tag = "inactive"
            else:
                score = 100
                burst_ratio = burst_cnt / max(1, len(u_today_sorted))
                if burst_ratio > 0.5 and len(u_today_sorted) >= 4:
                    score -= 30
                elif burst_cnt >= 3:
                    score -= 15
                score -= late_cnt * 15
                score -= min(20, edit_cnt * 5)
                score = max(10, score)
                score_str = f"{score}점"

                if score >= 85:
                    verdict = "✅ 정상 · 현장 순차 성실 측정"
                    tag = "good"
                elif score >= 65:
                    verdict = "⚠️ 주의 · 연속 몰아치기/수정 다수"
                    tag = "warn"
                else:
                    verdict = "🚨 의심 · 일괄 몰아치기/소급 입력"
                    tag = "bad"

            self.tree_staff.insert(
                "", "end", iid=user, tags=(tag,),
                values=(
                    user,
                    f"{len(u_today_sorted)}건",
                    f"{len(u_active)}건",
                    ", ".join(today_sites) if today_sites else "-",
                    first_t,
                    last_t,
                    work_span_str,
                    f"{burst_cnt}건",
                    f"{late_cnt}건",
                    f"{edit_cnt}건",
                    score_str,
                    verdict,
                )
            )

        self.kpi_vars["suspect_count"].set(f"{total_suspect}건")

    def on_select_staff(self, event):
        sel = self.tree_staff.selection()
        if not sel:
            return
        user = sel[0]
        rows = self.staff_records_by_user.get(user, [])
        self.staff_detail_label.configure(text=f"▼ [{user}] 직원의 입력 타임라인 및 간격 정밀 분석 (총 {len(rows)}건)")
        self.tree_staff_detail.delete(*self.tree_staff_detail.get_children())

        prev_dt = None
        for r in rows:
            t_str = safe_get(r, COL["time"])
            cur_dt = parse_dt(t_str)
            gap_str = "첫 입력"
            flags = []

            if prev_dt and cur_dt:
                sec = int((cur_dt - prev_dt).total_seconds())
                if sec < 60:
                    gap_str = f"⚡ {sec}초 만"
                    flags.append("몰아치기(1분내)")
                elif sec < 3600:
                    gap_str = f"{sec // 60}분 {sec % 60}초"
                else:
                    gap_str = f"{sec // 3600}시간 {(sec % 3600) // 60}분"
            prev_dt = cur_dt

            m_date = safe_get(r, COL["date"])
            if t_str[:10] and m_date and t_str[:10] != m_date:
                flags.append(f"소급입력({m_date})")

            if safe_get(r, COL["history"]):
                flags.append("수정됨")

            vals = [safe_get(r, COL["value"]), safe_get(r, COL["value2"]), safe_get(r, COL["value3"])]
            vals = [v for v in vals if v != ""]
            val_str = " / ".join(vals) + (f" {safe_get(r, COL['unit'])}" if vals else "")
            if safe_get(r, COL["status"]) and safe_get(r, COL["status"]) != "삭제":
                val_str = f"⚠ {safe_get(r, COL['status'])}"

            flag_text = " · ".join(flags) if flags else "정상"
            tag = "flag_bad" if "소급" in flag_text else ("flag_warn" if flags else "normal")

            memo_hist = safe_get(r, COL["memo"])
            if safe_get(r, COL["history"]):
                memo_hist = f"{memo_hist} [{safe_get(r, COL['history'])}]".strip()

            self.tree_staff_detail.insert(
                "", "end", tags=(tag,),
                values=(
                    t_str, gap_str, m_date, safe_get(r, COL["site"]),
                    safe_get(r, COL["id"]), safe_get(r, COL["type"]),
                    val_str, safe_get(r, COL["delta"]), safe_get(r, COL["weather"]),
                    flag_text, memo_hist
                )
            )

    def populate_live_feed(self):
        self.tree_live.delete(*self.tree_live.get_children())
        f_site = self.filter_site_var.get()
        f_user = self.filter_user_var.get()
        kw = self.search_var.get().strip().lower()

        rows = list(reversed(self.sync_data["records"]))
        self.current_live_rows = []

        for r in rows:
            site = safe_get(r, COL["site"])
            user = safe_get(r, COL["user"])
            if f_site and f_site != "전체" and site != f_site:
                continue
            if f_user and f_user != "전체" and user != f_user:
                continue
            if kw:
                hay = " ".join(str(c) for c in r).lower()
                if kw not in hay:
                    continue

            self.current_live_rows.append(r)
            vals = [safe_get(r, COL["value"]), safe_get(r, COL["value2"]), safe_get(r, COL["value3"])]
            vals = [v for v in vals if v != ""]
            val_str = (" / ".join(vals) + f" {safe_get(r, COL['unit'])}").strip() if vals else "-"

            status = safe_get(r, COL["status"])
            hist = safe_get(r, COL["history"])
            link = safe_get(r, COL["link"])

            tag = ""
            if status == "삭제":
                tag = "deleted"
            elif status:
                tag = "issue"
            elif hist:
                tag = "edited"

            self.tree_live.insert(
                "", "end", tags=(tag,) if tag else (),
                values=(
                    safe_get(r, COL["time"]),
                    safe_get(r, COL["date"]),
                    site, user,
                    safe_get(r, COL["id"]),
                    safe_get(r, COL["type"]),
                    safe_get(r, COL["place"]),
                    val_str,
                    safe_get(r, COL["prev"]),
                    safe_get(r, COL["delta"]),
                    status or ("수정됨" if hist else "정상"),
                    safe_get(r, COL["weather"]),
                    "📷 보기" if link else "-",
                    safe_get(r, COL["memo"]),
                )
            )

    def on_double_click_live(self, event):
        sel = self.tree_live.selection()
        if not sel:
            return
        idx = self.tree_live.index(sel[0])
        if idx < len(self.current_live_rows):
            r = self.current_live_rows[idx]
            link = safe_get(r, COL["link"])
            if link:
                for u in link.splitlines():
                    if u.strip().startswith("http"):
                        webbrowser.open(u.strip())
                        break

    def export_live_csv(self):
        if not getattr(self, "current_live_rows", None):
            messagebox.showinfo("알림", "내보낼 데이터가 없습니다.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV 파일 (엑셀 호환)", "*.csv")],
            initialfile=f"키움이엔씨_계측감독기록_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
        )
        if not path:
            return
        import csv
        head = ["저장시각", "클라이언트ID", "현장", "측정자", "계측기ID", "종류", "위치", "값", "단위", "전회값", "변화량", "메모", "사진링크", "측정일", "값2", "값3", "전회값2", "전회값3", "변화량2", "변화량3", "상태", "수정이력", "날씨"]
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(head)
            for r in self.current_live_rows:
                w.writerow(r)
        messagebox.showinfo("저장 완료", f"엑셀(CSV) 파일이 저장되었습니다:\n{path}")

    def populate_site_coverage(self, target_date, active_records):
        self.tree_sites.delete(*self.tree_sites.get_children())
        sites = self.sync_data["sites"]
        instruments = self.sync_data["instruments"]
        self.site_coverage_map = {}

        for site in sites:
            site_insts = [i for i in instruments if not i.get("site") or i.get("site") == site]
            rec_today = [
                r for r in active_records
                if safe_get(r, COL["site"]) == site and (
                    safe_get(r, COL["date"]) == target_date or safe_get(r, COL["time"]).startswith(target_date)
                )
            ]
            rec_by_id = {safe_get(r, COL["id"]): r for r in rec_today}
            done_cnt = sum(1 for i in site_insts if i["id"] in rec_by_id)
            total_cnt = len(site_insts)
            missing_cnt = max(0, total_cnt - done_cnt)
            rate = int(round((done_cnt / total_cnt) * 100)) if total_cnt > 0 else (100 if rec_today else 0)
            workers = sorted({safe_get(r, COL["user"]) for r in rec_today if safe_get(r, COL["user"])})
            last_up = max((safe_get(r, COL["time"]) for r in rec_today), default="-")

            self.site_coverage_map[site] = (site_insts, rec_by_id)
            tag = "complete" if (total_cnt > 0 and missing_cnt == 0) else ("partial" if rec_today else "zero")

            self.tree_sites.insert(
                "", "end", iid=site, tags=(tag,),
                values=(
                    site, f"{total_cnt}개", f"{done_cnt}개", f"{missing_cnt}개",
                    f"{rate}%", ", ".join(workers) if workers else "-", last_up
                )
            )

    def on_select_site_coverage(self, event):
        sel = self.tree_sites.selection()
        if not sel:
            return
        site = sel[0]
        site_insts, rec_by_id = self.site_coverage_map.get(site, ([], {}))
        self.site_inst_label.configure(text=f"🔍 [{site}] 계측기별 측정 여부 및 누락 점검 (총 {len(site_insts)}개)")
        self.tree_site_inst.delete(*self.tree_site_inst.get_children())

        for inst in site_insts:
            iid = inst.get("id", "")
            r = rec_by_id.get(iid)
            if not r:
                self.tree_site_inst.insert(
                    "", "end", tags=("missing",),
                    values=("❌ 미측정(누락)", iid, inst.get("type", ""), inst.get("place", ""), "-", "-", "-")
                )
            else:
                st = safe_get(r, COL["status"])
                val = f"⚠ {st}" if st else f"{safe_get(r, COL['value'])} {inst.get('unit', '')}".strip()
                tag = "issue" if st else "done"
                self.tree_site_inst.insert(
                    "", "end", tags=(tag,),
                    values=("⚠ 이상보고" if st else "✅ 측정완료", iid, inst.get("type", ""), inst.get("place", ""), safe_get(r, COL["user"]), val, safe_get(r, COL["time"]))
                )

    def populate_audit_and_issues(self, audit_rows, issue_rows):
        self.tree_audit.delete(*self.tree_audit.get_children())
        for r in reversed(audit_rows):
            self.tree_audit.insert(
                "", "end",
                values=(
                    safe_get(r, COL["time"]), safe_get(r, COL["site"]), safe_get(r, COL["user"]),
                    safe_get(r, COL["id"]), safe_get(r, COL["type"]), safe_get(r, COL["value"]),
                    safe_get(r, COL["status"]) or "수정됨", safe_get(r, COL["history"]), safe_get(r, COL["memo"])
                )
            )

        self.tree_issues.delete(*self.tree_issues.get_children())
        for r in reversed(issue_rows):
            self.tree_issues.insert(
                "", "end",
                values=(
                    safe_get(r, 0), safe_get(r, 4), safe_get(r, 2), safe_get(r, 3),
                    safe_get(r, 5), safe_get(r, 6), safe_get(r, 7), safe_get(r, 8),
                    safe_get(r, 9), safe_get(r, 10)
                )
            )

    def on_double_click_issue(self, event):
        sel = self.tree_issues.selection()
        if not sel:
            return
        vals = self.tree_issues.item(sel[0], "values")
        if len(vals) >= 10 and vals[9]:
            for u in str(vals[9]).splitlines():
                if u.strip().startswith("http"):
                    webbrowser.open(u.strip())
                    break

    def populate_drive_and_notes(self):
        self.tree_drive.delete(*self.tree_drive.get_children())
        drive = self.sync_data.get("drive") or {}

        for p_group in drive.get("photos", []):
            site = p_group.get("site", "")
            for f in p_group.get("files", []):
                self.tree_drive.insert(
                    "", "end",
                    values=("📷 현장사진", site, f.get("name", ""), f.get("updated", ""), f"{int(f.get('size', 0)) // 1024} KB", f.get("id", ""), f.get("url", ""))
                )

        for s_group in drive.get("surveys", []):
            site = s_group.get("site", "")
            for k_group in s_group.get("kinds", []):
                kind = k_group.get("kind", "")
                for f in k_group.get("files", []):
                    self.tree_drive.insert(
                        "", "end",
                        values=(f"🛰 측량({kind})", site, f.get("name", ""), f.get("updated", ""), f"{int(f.get('size', 0)) // 1024} KB", f.get("id", ""), f.get("url", ""))
                    )

        for d_group in drive.get("drawings", []):
            site = d_group.get("site", "")
            for f in d_group.get("files", []):
                self.tree_drive.insert(
                    "", "end",
                    values=("📐 도면(PDF)", site, f.get("name", ""), f.get("updated", ""), f"{int(f.get('size', 0)) // 1024} KB", f.get("id", ""), f.get("url", ""))
                )

        # 도면야장 노트 요약
        self.tree_notes.delete(*self.tree_notes.get_children())
        for r in reversed(self.sync_data.get("drawingNotes", [])):
            updated = safe_get(r, 0)
            site = safe_get(r, 2)
            fname = safe_get(r, 3)
            user = safe_get(r, 4)
            raw_json = safe_get(r, 5)
            pins_summary = ""
            pin_cnt = 0
            stroke_cnt = 0
            try:
                parsed = json.loads(raw_json) if raw_json else {}
                pins = parsed.get("pins", [])
                strokes = parsed.get("strokes", {})
                pin_cnt = len(pins)
                stroke_cnt = sum(len(v) for v in strokes.values()) if isinstance(strokes, dict) else 0
                texts = [f"#{i+1}({p.get('page',1)}쪽): {p.get('text','(빈 마커)')}" for i, p in enumerate(pins)]
                pins_summary = " | ".join(texts) if texts else "자유 펜 필기만 있음"
            except Exception:
                pins_summary = raw_json[:100]

            self.tree_notes.insert(
                "", "end",
                values=(updated, site, fname, user, f"마커 {pin_cnt}개 · 필기 {stroke_cnt}획", pins_summary)
            )

    def open_selected_drive_url(self):
        sel = self.tree_drive.selection()
        if not sel:
            messagebox.showinfo("알림", "먼저 목록에서 파일을 선택해 주세요.")
            return
        vals = self.tree_drive.item(sel[0], "values")
        if len(vals) >= 7 and vals[6]:
            webbrowser.open(vals[6])

    def download_selected_drive_file(self):
        sel = self.tree_drive.selection()
        if not sel:
            messagebox.showinfo("알림", "먼저 목록에서 내려받을 파일을 선택해 주세요.")
            return
        vals = self.tree_drive.item(sel[0], "values")
        file_name, file_id = vals[2], vals[5]
        if not file_id:
            return

        save_path = filedialog.asksaveasfilename(initialfile=file_name, title="클라우드 파일 PC 저장")
        if not save_path:
            return

        self.status_var.set(f"클라우드에서 '{file_name}' 파일을 내려받는 중...")

        def worker():
            try:
                res = self.call_api("drive_download", {"fileId": file_id})
                if res.get("ok") and res.get("base64"):
                    raw_bytes = base64.b64decode(res["base64"])
                    with open(save_path, "wb") as f:
                        f.write(raw_bytes)
                    self.after(0, lambda: self.on_download_done(save_path))
                else:
                    self.after(0, lambda: messagebox.showerror("오류", "파일을 내려받지 못했습니다."))
            except Exception as e:
                self.after(0, lambda: messagebox.showerror("오류", str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def on_download_done(self, save_path):
        self.status_var.set(f"파일 다운로드 완료: {save_path}")
        if messagebox.askyesno("다운로드 완료", f"파일이 저장되었습니다.\n지금 바로 파일을 열어보시겠습니까?\n\n{save_path}"):
            try:
                os.startfile(save_path)
            except Exception:
                webbrowser.open(save_path)

    # --------------------------------------------------------------------------
    # 보안 접속 코드 설정 다이얼로그
    # --------------------------------------------------------------------------
    def open_login_dialog(self):
        dlg = tk.Toplevel(self)
        dlg.title("보안 접속 코드 설정")
        dlg.geometry("460x260")
        dlg.configure(bg="#1E293B")
        dlg.transient(self)
        dlg.grab_set()

        tk.Label(dlg, text="🔒 대표님 전용 감독판 클라우드 연결", bg="#1E293B", fg="#F8FAFC", font=("맑은 고딕", 13, "bold")).pack(pady=(18, 6))
        tk.Label(dlg, text="직원용 앱과 동일한 보안 접속 코드를 입력하세요. (읽기 전용 스텔스 연결)", bg="#1E293B", fg="#94A3B8", font=("맑은 고딕", 9)).pack(pady=(0, 14))

        frm = tk.Frame(dlg, bg="#1E293B", padx=24)
        frm.pack(fill="x")

        tk.Label(frm, text="보안 접속 코드:", bg="#1E293B", fg="#CBD5E1", font=("맑은 고딕", 10, "bold")).pack(anchor="w")
        code_var = tk.StringVar(value=self.access_code)
        ent = tk.Entry(frm, textvariable=code_var, show="*", bg="#0F172A", fg="#F8FAFC", insertbackground="#F8FAFC", relief="flat", font=("맑은 고딕", 12))
        ent.pack(fill="x", pady=6, ipady=6)
        ent.focus_set()

        def save_and_connect(event=None):
            c = code_var.get().strip()
            if not c:
                messagebox.showwarning("입력 확인", "접속 코드를 입력해 주세요.", parent=dlg)
                return
            self.access_code = c
            self.save_local_config()
            dlg.destroy()
            self.sync_from_server(include_drive=True)

        ent.bind("<Return>", save_and_connect)
        tk.Button(
            frm, text="연결 및 실시간 감시 시작", command=save_and_connect,
            bg="#2563EB", fg="#FFFFFF", relief="flat", pady=8, font=("맑은 고딕", 10, "bold")
        ).pack(fill="x", pady=(12, 0))


if __name__ == "__main__":
    app = CEOMonitorApp()
    app.mainloop()
