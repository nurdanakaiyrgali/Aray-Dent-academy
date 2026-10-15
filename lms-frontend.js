/* DentAcademy LMS frontend bridge. Uses the existing Supabase client and RLS. */
(() => {
  const db = window.supabaseClient;
  let authUser = null;
  let activeCourse = null;
  let activeModule = null;
  let activeTest = null;
  let activeAttempt = null;
  let attemptTimeLimit = null;
  let attemptDeadline = null;
  let quizTimer = null;
  let submittingAttempt = false;
  let attemptAnswers = {};
  let attemptQuestions = [];
  let courseCache = [];
  let moduleCache = [];
  let busy = false;
  const el = (s, root = document) => root.querySelector(s);
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const notify = (s) => typeof toast === 'function' ? toast(s) : alert(s);
  const statusError = (e) => e?.message || 'Не удалось выполнить запрос. Проверьте подключение и права Supabase.';
  const icons = {dashboard:'grid', courses:'book', library:'file', tests:'clipboard', users:'users', analytics:'chart', account:'settings'};
  const routes = (admin) => admin ? [
    ['lms-dashboard','Обзор','dashboard'],['lms-courses','Управление курсами','courses'],
    ['lms-tests','Конструктор тестов','tests'],['lms-users','Пользователи','users'],
    ['lms-analytics','Аналитика обучения','analytics'],['profile','Аккаунт','account']
  ] : [
    ['lms-dashboard','Обзор','dashboard'],['lms-catalog','Каталог курсов','courses'],
    ['lms-my-courses','Моё обучение','library'],['lms-tests','Тесты и результаты','tests'],['profile','Аккаунт','account']
  ];
  const styles = document.createElement('style');
  styles.textContent = `.lms-wrap{display:grid;gap:18px}.lms-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.lms-card{padding:18px}.lms-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.lms-item{padding:16px;border:1px solid var(--line);border-radius:15px;background:var(--surface);display:grid;gap:9px}.lms-item p{margin:0;color:var(--muted);font-size:12px}.lms-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--green);font-weight:700}.lms-form{display:grid;gap:11px}.lms-form .field{margin:0}.lms-form input,.lms-form select,.lms-form textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text)}.lms-options{display:grid;gap:8px}.lms-option{display:flex;align-items:center;gap:9px;padding:10px;border:1px solid var(--line);border-radius:10px}.lms-option input{accent-color:var(--green)}.lms-row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.lms-empty{padding:25px;text-align:center;color:var(--muted)}.lms-stat{font:700 26px var(--display);color:var(--green)}.lms-file{max-width:100%;border:1px solid var(--line);border-radius:14px}.lms-lesson{display:grid;gap:9px;padding:13px;border:1px solid var(--line);border-radius:12px}.lms-muted{font-size:11px;color:var(--muted)}.lms-section{display:grid;gap:10px}.lms-nav-title{margin:18px 10px 8px;font-size:9px;letter-spacing:1px;color:#9ca9a1;font-weight:700}.lms-status{font-size:10px;color:var(--muted)}@media(max-width:700px){.lms-card{padding:14px}}`;
  document.head.append(styles);

  // The demo role toggle is removed. Only the database-backed profile can grant admin.
  try { localStorage.removeItem('da-role'); } catch {}
  app.role = 'learner';
  const savedDemoProfile = {...app.profile};
  const originalAuthModal = authModal;
  const originalModalAction = modalForAction;
  const originalRenderPage = renderPage;

  function renderNav() {
    const sidebar = el('#sidebar');
    if (!sidebar) return;
    const admin = app.role === 'admin';
    const list = routes(admin);
    const navs = sidebar.querySelectorAll('.nav-list');
    const navLabels = sidebar.querySelectorAll('.nav-label');
    if (navs[0]) navs[0].innerHTML = list.slice(0, admin ? 3 : 4).map(([page, label, ico]) => `<button class="nav-item ${app.page===page?'active':''}" data-page="${page}">${icon(icons[ico])}${label}</button>`).join('');
    if (navs[1]) navs[1].innerHTML = admin ? list.slice(3,5).map(([page,label,ico])=>`<button class="nav-item ${app.page===page?'active':''}" data-page="${page}">${icon(icons[ico])}${label}</button>`).join('') : '';
    if (navLabels[0]) navLabels[0].textContent = admin ? 'УПРАВЛЕНИЕ LMS' : 'ОБУЧЕНИЕ';
    if (navLabels[1]) { navLabels[1].hidden = !admin; navLabels[1].textContent = 'АДМИНИСТРИРОВАНИЕ'; }
    const org = sidebar.querySelector('.org-switch'); if (org) org.hidden = true;
    const weekly = sidebar.querySelector('.weekly-mini'); if (weekly) weekly.hidden = !!authUser;
    const profileButton = sidebar.querySelector('.sidebar-bottom>.nav-item');
    if (profileButton) { profileButton.dataset.page = 'profile'; profileButton.innerHTML = `${icon('settings')}Аккаунт · профиль`; }
    const mini = sidebar.querySelector('.profile-mini');
    if (mini) { mini.dataset.page = 'profile'; const b=mini.querySelector('b'),s=mini.querySelector('small'); if(b)b.textContent=authUser?(app.profile.name||authUser.email):'Демо-профиль'; if(s)s.textContent=authUser?(admin?'Администратор':'Обучающийся'):'Войдите для синхронизации'; }
    const switcher = el('#roleSwitcher'); if (switcher) switcher.remove();
    let authButtons = el('#lmsAuthButtons');
    if (!authButtons) { authButtons=document.createElement('div'); authButtons.id='lmsAuthButtons'; authButtons.className='lms-row'; const top=el('.top-actions'); top?.prepend(authButtons); }
    authButtons.innerHTML = authUser
      ? `<span class="lms-muted">${admin?'Администратор':'Обучающийся'}</span><button class="btn btn-outline btn-sm" data-action="lms-logout">Выйти</button>`
      : `<button class="btn btn-outline btn-sm" data-action="lms-login">Войти</button><button class="btn btn-primary btn-sm" data-action="lms-register">Регистрация</button>`;
    const account = el('#accountBtn'); if(account) account.textContent=(app.profile.name||'DA').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase();
  }

  function head(title, sub='') { return `<div class="page-heading"><div><div class="eyebrow">ARAY DENT ACADEMY · ${app.role==='admin'?'АДМИНИСТРАТОР':'ОБУЧЕНИЕ'}</div><h1>${esc(title)}</h1><p class="subhead">${esc(sub)}</p></div></div>`; }
  function errCard(message) { return `<div class="card lms-card"><b>Не удалось загрузить данные</b><p class="lms-muted">${esc(message)}</p><button class="btn btn-outline btn-sm" data-action="lms-refresh">Повторить</button></div>`; }
  function pageShell(title, sub, body) { el('#crumbSection').textContent=app.role==='admin'?'Управление LMS':'Обучение'; el('#crumbPage').textContent=title; el('#page').innerHTML=head(title,sub)+`<div class="lms-wrap">${body}</div>`; }
  function setBusy(button, yes) { if(button){button.disabled=yes;button.dataset.oldText ||= button.textContent;button.textContent=yes?'Сохранение…':button.dataset.oldText;} }

  async function loadAuthProfile(user) {
    authUser=user; app.authUserId=user.id;
    const {data,error}=await db.from('profiles').select('id,full_name,email,role,learner_status,specialty,experience_years,region,city,phone,is_active').eq('id',user.id).maybeSingle();
    if(error){console.error(error);app.role='learner';app.page='lms-dashboard';notify('Не удалось загрузить профиль: '+statusError(error));renderNav();renderPage();return;}
    if(!data){app.role='learner';app.page='lms-dashboard';notify('Профиль не найден. Проверьте, что миграция Supabase применена.');renderNav();renderPage();return;}
    if(data.is_active===false){await db.auth.signOut();authUser=null;app.role='learner';notify('Аккаунт временно отключён.');renderNav();return;}
    app.role=data.role==='admin'?'admin':'learner';
    app.profile={...savedDemoProfile,name:data.full_name||user.user_metadata?.full_name||user.email,email:user.email||data.email||'',role:data.role,specialty:data.specialty||user.user_metadata?.specialty||'',learnerStatus:data.learner_status||user.user_metadata?.learner_status||'student',experienceYears:data.experience_years??user.user_metadata?.experience_years??null,region:data.city||data.region||'',phone:data.phone||''};
    const patch={}; if(user.user_metadata?.learner_status && data.learner_status==='student' && user.user_metadata.learner_status!=='student')patch.learner_status=user.user_metadata.learner_status; if(user.user_metadata?.experience_years && data.experience_years==null)patch.experience_years=Number(user.user_metadata.experience_years); if(user.user_metadata?.specialty && !data.specialty)patch.specialty=user.user_metadata.specialty;
    if(Object.keys(patch).length) await db.from('profiles').update(patch).eq('id',user.id);
    app.page='lms-dashboard'; renderNav(); renderPage();
  }
  window.loadAuthProfile=loadAuthProfile;

  authModal=function(type='login'){
    originalAuthModal(type);
    if(type==='register'){
      const modal=el('#modalContent');
      modal.innerHTML=`<h2>Создать аккаунт обучающегося</h2><p class="subhead">Роль обучающегося назначается автоматически. Статус описывает ваш опыт и не меняет доступы.</p><div class="field"><label>ФИО *</label><input id="authName" autocomplete="name" placeholder="Имя и фамилия"></div><div class="field"><label>Почта *</label><input id="authEmail" type="email" autocomplete="email" placeholder="name@example.kz"></div><div class="field"><label>Ваш статус</label><select id="authAccountType"><option value="student">Студент</option><option value="intern">Интерн / стажёр</option><option value="practicing_doctor">Практикующий врач</option></select></div><div class="field"><label>Специализация</label><input id="authSpecialty" placeholder="Например, терапевтическая стоматология"></div><div class="field"><label>Стаж, лет</label><input id="authExperience" type="number" min="0" max="80" placeholder="Необязательно"></div><div class="field"><label>Пароль *</label><input id="authPassword" type="password" minlength="8" autocomplete="new-password" placeholder="Не менее 8 символов"></div><p class="auth-note">Для подтверждения может потребоваться ссылка из письма.</p><div class="modal-actions"><button class="btn btn-outline" data-auth="login">Уже есть аккаунт</button><button class="btn btn-primary" data-action="lms-signup">Создать аккаунт</button></div>`;
    }
  };

  async function renderDashboard() {
    if(app.role==='admin'){
      const [courses,users,attempts]=await Promise.all([
        db.from('courses').select('id,status').limit(1000),
        db.from('profiles').select('id,is_active').limit(1000),
        db.from('lms_test_attempts').select('id,passed').limit(1000)
      ]);
      const error=courses.error||users.error||attempts.error; if(error)return pageShell('Обзор','Показатели из базы платформы',errCard(statusError(error)));
      return pageShell('Обзор','Показатели обучения из Supabase · без демонстрационных чисел',`<div class="lms-grid"><div class="card lms-card"><span class="lms-kicker">Курсы</span><div class="lms-stat">${courses.data.length}</div><span class="lms-muted">${courses.data.filter(x=>x.status==='published').length} опубликовано</span></div><div class="card lms-card"><span class="lms-kicker">Пользователи</span><div class="lms-stat">${users.data.length}</div><span class="lms-muted">${users.data.filter(x=>x.is_active).length} активных</span></div><div class="card lms-card"><span class="lms-kicker">Попытки тестов</span><div class="lms-stat">${attempts.data.length}</div><span class="lms-muted">${attempts.data.filter(x=>x.passed).length} сдано</span></div></div><div class="card lms-card"><h2>Управление платформой</h2><p class="lms-muted">Создайте структуру курса, прикрепите лекционные файлы к урокам и настройте тесты.</p><div class="lms-row"><button class="btn btn-primary" data-page="lms-courses">Открыть курсы</button><button class="btn btn-outline" data-page="lms-tests">Конструктор тестов</button><button class="btn btn-outline" data-page="lms-users">Пользователи</button></div></div>`);
    }
    const {data,error}=await db.from('enrollments').select('id,state,course_id,courses(id,title,description,status)').eq('user_id',authUser.id).order('enrolled_at',{ascending:false});
    if(error)return pageShell('Обзор','Ваше обучение и результаты',errCard(statusError(error)));
    const rows=data||[];
    pageShell('Обзор','Ваши реальные курсы, загруженные из Supabase',rows.length?`<div class="lms-grid">${rows.map(r=>`<article class="card lms-item"><span class="lms-kicker">${r.state==='completed'?'Завершён':'В обучении'}</span><h2>${esc(r.courses?.title||'Курс')}</h2><p>${esc(r.courses?.description||'')}</p><button class="btn btn-primary btn-sm" data-action="lms-open-course" data-course-id="${esc(r.course_id)}">Открыть курс</button></article>`).join('')}</div>`:`<div class="card lms-card lms-empty"><h2>Пока нет записей на курсы</h2><p>Откройте каталог и выберите опубликованный курс.</p><button class="btn btn-primary" data-page="lms-catalog">Перейти в каталог</button></div>`);
  }
  async function loadCatalog(onlyMine=false) {
    let q=db.from('courses').select('id,title,description,level,status,directions(title)').eq('status','published').order('created_at',{ascending:false});
    if(onlyMine){const {data:en,error:ee}=await db.from('enrollments').select('course_id,state').eq('user_id',authUser.id).in('state',['active','completed']);if(ee)return pageShell('Моё обучение','Ваши курсы',errCard(statusError(ee)));const ids=(en||[]).map(x=>x.course_id);if(!ids.length)return pageShell('Моё обучение','Курсы, на которые вы записаны','<div class="card lms-empty">Здесь появятся ваши курсы после записи.</div>');q=q.in('id',ids);}
    const {data,error}=await q; if(error)return pageShell(onlyMine?'Моё обучение':'Каталог курсов','Курсы из Supabase',errCard(statusError(error)));
    courseCache=data||[];
    const title=onlyMine?'Моё обучение':'Каталог курсов';
    pageShell(title,onlyMine?'Ваши активные и завершённые курсы':'Выберите курс и запишитесь на обучение',courseCache.length?`<div class="lms-grid">${courseCache.map(c=>`<article class="card lms-item"><span class="lms-kicker">${esc(c.directions?.title||c.level||'Программа')}</span><h2>${esc(c.title)}</h2><p>${esc(c.description||'Описание курса появится после публикации.')}</p><div class="lms-row">${onlyMine?`<button class="btn btn-primary btn-sm" data-action="lms-open-course" data-course-id="${esc(c.id)}">Продолжить</button>`:`<button class="btn btn-primary btn-sm" data-action="lms-enroll" data-course-id="${esc(c.id)}">Записаться</button><button class="btn btn-outline btn-sm" data-action="lms-course-preview" data-course-id="${esc(c.id)}">Программа</button>`}</div></article>`).join('')}</div>`:'<div class="card lms-empty">Опубликованных курсов пока нет.</div>');
  }
  async function openCourse(id) {
    const {data:course,error}=await db.from('courses').select('id,title,description,status,level').eq('id',id).single(); if(error)return pageShell('Курс','',errCard(statusError(error)));
    activeCourse=course;
    const {data:units,error:ue}=await db.from('course_units').select('id,title,description,sort_order,status').eq('course_id',id).order('sort_order'); if(ue)return pageShell(course.title,'Программа курса',errCard(statusError(ue)));
    moduleCache=units||[];
    const {data:lessons,error:le}=await db.from('lessons').select('id,unit_id,title,body,content_markdown,lesson_type,duration_minutes,sort_order,status').in('unit_id',moduleCache.map(x=>x.id).length?moduleCache.map(x=>x.id):['00000000-0000-0000-0000-000000000000']).order('sort_order'); if(le)return pageShell(course.title,'Программа курса',errCard(statusError(le)));
    const byUnit={};for(const l of lessons||[])(byUnit[l.unit_id] ||= []).push(l);
    const body=moduleCache.length?moduleCache.map(u=>`<section class="card lms-card lms-section"><div class="lms-toolbar"><div><span class="lms-kicker">Модуль ${u.sort_order+1} · ${esc(u.status)}</span><h2>${esc(u.title)}</h2><p class="lms-muted">${esc(u.description||'')}</p></div></div>${(byUnit[u.id]||[]).map(l=>`<div class="lms-lesson"><div class="lms-toolbar"><b>${esc(l.title)}</b><span class="lms-status">${esc(l.duration_minutes||'')} мин · ${esc(l.status)}</span></div>${l.content_markdown?`<p>${esc(l.content_markdown)}</p>`:''}<div class="lms-row"><button class="btn btn-soft btn-sm" data-action="lms-lesson" data-lesson-id="${esc(l.id)}">Открыть урок</button><button class="btn btn-outline btn-sm" data-action="lms-mark-lesson" data-lesson-id="${esc(l.id)}">Отметить пройденным</button></div></div>`).join('')||'<p class="lms-muted">В этом модуле ещё нет опубликованных уроков.</p>'}</section>`).join(''):'<div class="card lms-empty">Программа курса пока не опубликована.</div>';
    pageShell(course.title,course.description||'Материалы курса и уроки',`<button class="btn btn-outline btn-sm" data-page="lms-my-courses">← К моему обучению</button>${body}`);
  }
  async function openLesson(id) {
    const {data:lesson,error}=await db.from('lessons').select('id,title,body,content_markdown,lesson_type,duration_minutes').eq('id',id).single();if(error)return notify(statusError(error));
    const {data:links,error:me}=await db.from('lesson_materials').select('sort_order,library_materials(id,title,description,storage_path,mime_type,byte_size)').eq('lesson_id',id).order('sort_order');if(me)return notify(statusError(me));
    let materials=''; for(const row of links||[]){const m=row.library_materials;if(!m)continue;let url='';if(m.storage_path){const {data,error:se}=await db.storage.from('course-materials').createSignedUrl(m.storage_path,300);if(se){materials+=`<div class="lms-lesson">${esc(m.title)}<p class="lms-muted">${esc(statusError(se))}</p></div>`;continue;}url=data.signedUrl;}materials+=`<div class="lms-lesson"><b>${esc(m.title)}</b><p class="lms-muted">${esc(m.description||'')}</p>${url?(m.mime_type?.startsWith('video/')?`<video class="lms-file" controls controlsList="nodownload" src="${esc(url)}"></video>`:`<iframe class="lms-file" title="${esc(m.title)}" src="${esc(url)}" style="width:100%;height:62vh"></iframe>`):''}</div>`;}
    pageShell(lesson.title,'Учебный материал курса',`<button class="btn btn-outline btn-sm" data-action="lms-back-course">← К программе</button><article class="card lms-card"><p>${esc(lesson.content_markdown||lesson.body||'')}</p><div class="lms-muted">${esc(lesson.lesson_type||'Лекция')} · ${esc(lesson.duration_minutes||'')} мин</div></article>${materials||'<div class="card lms-empty">К уроку пока не прикреплены материалы.</div>'}<button class="btn btn-primary" data-action="lms-mark-lesson" data-lesson-id="${esc(lesson.id)}">Отметить урок пройденным</button>`);
  }
  async function loadAdminCourses() {
    const {data,error}=await db.from('courses').select('id,title,description,status,level,created_at').order('created_at',{ascending:false}); if(error)return pageShell('Управление курсами','Создание программ обучения',errCard(statusError(error)));
    courseCache=data||[];
    pageShell('Управление курсами','Создавайте направление → курс → модуль → урок и публикуйте материалы',`<section class="card lms-card"><h2>Новый курс</h2><form id="lmsCourseForm" class="lms-form"><div class="field"><label>Направление</label><input name="direction" placeholder="Например, терапия или ортодонтия"></div><div class="field"><label>Название курса *</label><input name="title" required></div><div class="field"><label>Описание</label><textarea name="description" rows="2"></textarea></div><div class="field"><label>Уровень</label><select name="level"><option value="basic">Базовый</option><option value="advanced">Продвинутый</option><option value="expert">Экспертный</option></select></div><label class="lms-option"><input name="test_required" type="checkbox"><span>Требовать опубликованный тест для публикации курса</span></label><button class="btn btn-primary" type="submit">Создать черновик</button></form></section><div class="lms-grid">${courseCache.map(c=>`<article class="card lms-item"><span class="lms-kicker">${esc(c.status)} · ${esc(c.level)}</span><h2>${esc(c.title)}</h2><p>${esc(c.description||'')}</p><div class="lms-row"><button class="btn btn-outline btn-sm" data-action="lms-admin-course" data-course-id="${esc(c.id)}">Редактировать программу</button>${c.status!=='published'?`<button class="btn btn-soft btn-sm" data-action="lms-publish-course" data-course-id="${esc(c.id)}">Опубликовать</button>`:''}</div></article>`).join('')||'<div class="card lms-empty">Курсов пока нет. Создайте первый.</div>'}</div>`);
  }
  async function adminCourse(id) {
    const {data:course,error}=await db.from('courses').select('id,title,description,status,level,organization_id,test_required').eq('id',id).single();if(error)return notify(statusError(error));activeCourse=course;
    const {data:units,error:ue}=await db.from('course_units').select('id,title,description,sort_order,status').eq('course_id',id).order('sort_order');if(ue)return notify(statusError(ue));moduleCache=units||[];
    const lessonData=await Promise.all(moduleCache.map(async u=>{const {data}=await db.from('lessons').select('id,title,status,sort_order').eq('unit_id',u.id).order('sort_order');return [u,data||[]]}));
    const modules=lessonData.map(([u,ls])=>`<section class="card lms-card lms-section"><div class="lms-toolbar"><div><span class="lms-kicker">${esc(u.status)} · модуль ${u.sort_order+1}</span><h2>${esc(u.title)}</h2></div><button class="btn btn-outline btn-sm" data-action="lms-publish-module" data-module-id="${esc(u.id)}">Опубликовать модуль</button></div>${ls.map(l=>`<div class="lms-lesson"><div class="lms-toolbar"><b>${esc(l.title)}</b><span class="lms-status">${esc(l.status)}</span></div><div class="lms-row"><button class="btn btn-outline btn-sm" data-action="lms-upload-lesson" data-lesson-id="${esc(l.id)}">Прикрепить файл</button><button class="btn btn-soft btn-sm" data-action="lms-publish-lesson" data-lesson-id="${esc(l.id)}">Опубликовать урок</button></div></div>`).join('')}<form class="lms-form" data-lesson-form="${esc(u.id)}"><div class="field"><label>Новый урок</label><input name="title" required placeholder="Название урока"><textarea name="body" rows="2" placeholder="Краткое содержание"></textarea></div><button class="btn btn-outline btn-sm" type="submit">Добавить урок</button></form></section>`).join('');
    const otherCourses=(await db.from('courses').select('id,title').neq('id',course.id).order('title')).data||[];
    const prereqs=(await db.from('course_prerequisites').select('required_course_id').eq('course_id',course.id)).data||[];
    const prereqIds=new Set(prereqs.map(x=>x.required_course_id));
    pageShell(course.title,'Редактор курса · модули, уроки, пререквизиты и лекционные файлы',`<div class="lms-row"><button class="btn btn-outline btn-sm" data-page="lms-courses">← Все курсы</button><button class="btn btn-soft btn-sm" data-action="lms-publish-course" data-course-id="${esc(course.id)}">Опубликовать курс</button><span class="lms-muted">Требуется тест: ${course.test_required?'да':'нет'}</span></div><section class="card lms-card"><h2>Пререквизиты</h2><p class="lms-muted">Ученик сможет записаться после завершения выбранного курса либо успешного входного теста.</p><form id="lmsPrerequisiteForm" class="lms-row"><select name="required_course_id" required><option value="">Выберите курс</option>${otherCourses.map(c=>`<option value="${esc(c.id)}" ${prereqIds.has(c.id)?'disabled':''}>${esc(c.title)}</option>`).join('')}</select><button class="btn btn-outline btn-sm">Добавить требование</button></form><div class="lms-muted">Установлено требований: ${prereqs.length}</div></section><section class="card lms-card"><h2>Добавить модуль</h2><form id="lmsModuleForm" class="lms-form"><div class="field"><label>Название модуля *</label><input name="title" required></div><div class="field"><label>Описание</label><input name="description"></div><button class="btn btn-primary" type="submit">Создать модуль</button></form></section>${modules||'<div class="card lms-empty">Добавьте первый модуль.</div>'}`);
  }

  async function publishCourse(id) {
    const {data:units,error}=await db.from('course_units').select('id,status').eq('course_id',id);if(error)return notify(statusError(error));
    const published=(units||[]).filter(x=>x.status==='published').map(x=>x.id);if(!published.length)return notify('Сначала опубликуйте хотя бы один модуль.');
    const {data:lessons,error:le}=await db.from('lessons').select('id').in('unit_id',published).eq('status','published');if(le)return notify(statusError(le));if(!lessons?.length)return notify('Сначала опубликуйте хотя бы один урок.');
    const {data:links,error:me}=await db.from('lesson_materials').select('material_id,lessons!inner(unit_id),library_materials!inner(status)').in('lessons.unit_id',published).eq('library_materials.status','published');
    if(me)return notify(statusError(me));if(!links?.length)return notify('Прикрепите к уроку и опубликуйте хотя бы один учебный материал.');
    const {data:course,error:ce}=await db.from('courses').select('test_required').eq('id',id).single();if(ce)return notify(statusError(ce));
    if(course.test_required){const {data:tests,error:te}=await db.from('tests').select('id').eq('course_id',id).eq('status','published');if(te)return notify(statusError(te));if(!tests?.length)return notify('Для этого курса требуется опубликованный тест.');}
    const {error:pe}=await db.from('courses').update({status:'published',published_at:new Date().toISOString()}).eq('id',id);if(pe)return notify(statusError(pe));notify('Курс опубликован');renderPage();
  }
  async function loadAdminTests() {
    const {data:tests,error}=await db.from('tests').select('id,title,kind,status,passing_score,course_id,unit_id').order('created_at',{ascending:false});if(error)return pageShell('Конструктор тестов','Свяжите проверку знаний с курсом и модулем',errCard(statusError(error)));
    const {data:courses}=await db.from('courses').select('id,title').order('title');courseCache=courses||[];
    const courseOptions=courseCache.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    pageShell('Конструктор тестов','Создавайте тесты курса, добавляйте вопросы, назначайте участникам курса и задавайте правила',`<section class="card lms-card"><h2>Новый тест</h2><form id="lmsTestForm" class="lms-form"><div class="field"><label>Название *</label><input name="title" required></div><div class="field"><label>Курс *</label><select name="course_id" required><option value="">Выберите курс</option>${courseOptions}</select></div><div class="field"><label>Модуль</label><select name="unit_id"><option value="">Итоговый тест курса</option></select></div><div class="lms-row"><label>Тип <select name="kind"><option value="module">Модульный</option><option value="entry">Входной</option><option value="final">Итоговый</option></select></label><label>Проходной балл, % <input name="passing_score" type="number" min="0" max="100" value="80"></label><label>Попыток <input name="max_attempts" type="number" min="1" max="20" value="3"></label><label>Лимит времени, мин <input name="time_limit_minutes" type="number" min="1" max="300" placeholder="Без лимита"></label></div><p class="lms-muted">Тест доступен записанным на курс ученикам, включая новые зачисления.</p><button class="btn btn-primary" type="submit">Создать черновик теста</button></form></section><div class="lms-grid">${(tests.data||[]).map(t=>`<article class="card lms-item"><span class="lms-kicker">${esc(t.status)} · порог ${t.passing_score}%</span><h2>${esc(t.title)}</h2><p>${esc(t.kind)}</p><div class="lms-row"><button class="btn btn-outline btn-sm" data-action="lms-edit-test" data-test-id="${esc(t.id)}">Добавить вопросы</button>${t.status!=='published'?`<button class="btn btn-soft btn-sm" data-action="lms-publish-test" data-test-id="${esc(t.id)}">Опубликовать</button>`:''}</div></article>`).join('')||'<div class="card lms-empty">Тестов пока нет.</div>'}</div>`);
    el('[name="course_id"]')?.addEventListener('change',async e=>{const {data}=await db.from('course_units').select('id,title').eq('course_id',e.target.value).order('sort_order');const select=el('[name="unit_id"]');if(select)select.innerHTML='<option value="">Итоговый тест курса</option>'+(data||[]).map(x=>`<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')});
  }
  async function editTest(id) {
    const {data:test,error}=await db.from('tests').select('id,title,settings,course_id,unit_id').eq('id',id).single();if(error)return notify(statusError(error));activeTest=test;
    const {data:questions,error:qe}=await db.from('lms_questions').select('id,prompt,question_type,points,sort_order').eq('test_id',id).order('sort_order');if(qe)return notify(statusError(qe));
    const courseId=test.course_id||(await db.from('course_units').select('course_id').eq('id',test.unit_id).single()).data?.course_id;
    const {data:enrollments,error:enrollmentError}=await db.from('enrollments').select('user_id').eq('course_id',courseId).in('state',['active','completed']);if(enrollmentError)return notify(statusError(enrollmentError));
    const learnerIds=[...new Set((enrollments||[]).map(x=>x.user_id))];
    const [users,groups,assigned]=await Promise.all([
      learnerIds.length?db.from('profiles').select('id,full_name,email').in('id',learnerIds).order('full_name'):Promise.resolve({data:[],error:null}),
      db.from('study_groups').select('id,name').order('name'),
      db.from('test_assignments').select('id,user_id,group_id').eq('test_id',id)
    ]);const accessError=users.error||groups.error||assigned.error;if(accessError)return notify(statusError(accessError));
    const targets=[...(users.data||[]).map(x=>({id:x.id,label:`Ученик · ${x.full_name||x.email||x.id}`,kind:'user'})),...(groups.data||[]).map(x=>({id:x.id,label:`Группа · ${x.name}`,kind:'group'}))];
    pageShell(`Вопросы · ${test.title}`,'Верные ответы хранятся в базе и не передаются ученикам до отправки теста',`<button class="btn btn-outline btn-sm" data-page="lms-tests">← К тестам</button><section class="card lms-card"><h2>Назначение доступа</h2><p class="lms-muted">По умолчанию тест открыт всем текущим и будущим записанным на курс. Можно ограничить его конкретными учениками или группами.</p><form id="lmsAssignmentForm" class="lms-row"><select name="target_id" required><option value="">Выберите ученика или группу</option>${targets.map(t=>`<option value="${esc(t.kind+':'+t.id)}">${esc(t.label)}</option>`).join('')}</select><button class="btn btn-outline btn-sm">Добавить назначение</button></form><div class="lms-muted">Учеников, записанных на курс: ${learnerIds.length} · точечных назначений: ${(assigned.data||[]).length} · режим: ${test.settings?.assign_all_enrollments===false?'выбранные участники':'все записанные'}</div></section><section class="card lms-card"><h2>Добавить вопрос</h2><form id="lmsQuestionForm" class="lms-form"><div class="field"><label>Текст вопроса *</label><textarea name="prompt" rows="3" required></textarea></div><div class="lms-row"><label>Тип <select name="question_type"><option value="single_choice">Один ответ</option><option value="multiple_choice">Несколько ответов</option><option value="true_false">Верно / неверно</option></select></label><label>Баллы <input type="number" name="points" min="0.1" step="0.1" value="1"></label></div><div class="lms-options">${[1,2,3,4].map(i=>`<label class="lms-option" data-option-row="${i}"><input type="checkbox" name="correct" value="${i}"><input name="option${i}" placeholder="Вариант ${i}" ${i<3?'required':''}></label>`).join('')}</div><button class="btn btn-outline btn-sm" type="button" data-action="lms-add-option">Добавить вариант ответа</button><button class="btn btn-primary" type="submit">Сохранить вопрос</button></form></section><div class="card lms-card"><h2>Вопросы · ${(questions||[]).length}</h2>${(questions||[]).map((q,i)=>`<div class="lms-lesson"><b>${i+1}. ${esc(q.prompt)}</b><span class="lms-muted">${esc(q.question_type)} · ${q.points} балл.</span></div>`).join('')||'<p class="lms-muted">Добавьте вопросы, затем опубликуйте тест.</p>'}</div>`);
  }
  async function loadAdminUsers() {
    const {data,error}=await db.from('profiles').select('id,full_name,email,role,learner_status,specialty,is_active,created_at').order('created_at',{ascending:false}).limit(500);if(error)return pageShell('Пользователи','Управление аккаунтами и зачислениями',errCard(statusError(error)));
    pageShell('Пользователи','Список загружен из profiles; новые пользователи по умолчанию получают роль learner',`<div class="card lms-card"><div class="lms-toolbar"><h2>Аккаунты · ${(data||[]).length}</h2><input id="lmsUserSearch" placeholder="Поиск по имени или почте"></div><div id="lmsUsersList" class="lms-section">${(data||[]).map(u=>`<div class="lms-lesson lms-user-row"><div class="lms-toolbar"><div><b>${esc(u.full_name||'Без имени')}</b><div class="lms-muted">${esc(u.email||'')} · ${esc(u.specialty||'Специализация не указана')}</div></div><span class="status ${u.role==='admin'?'':'neutral'}">${u.role==='admin'?'Администратор':'Обучающийся · '+esc(u.learner_status||'student')}</span></div></div>`).join('')||'<p class="lms-muted">Пользователей пока нет.</p>'}</div></div>`);
    el('#lmsUserSearch')?.addEventListener('input',e=>{const q=e.target.value.toLowerCase();$$('.lms-user-row').forEach(x=>x.hidden=!x.textContent.toLowerCase().includes(q))});
  }
  async function loadAnalytics() {
    const [en,att,courses]=await Promise.all([db.from('enrollments').select('id,state,course_id').limit(3000),db.from('lms_test_attempts').select('id,passed,percentage,test_id').not('submitted_at','is',null).limit(3000),db.from('courses').select('id,title')]);
    const e=en.error||att.error||courses.error;if(e)return pageShell('Аналитика обучения','Только реальные данные базы',errCard(statusError(e)));
    const passed=(att.data||[]).filter(a=>a.passed).length,avg=(att.data||[]).length?Math.round(att.data.reduce((s,a)=>s+Number(a.percentage||0),0)/att.data.length):0;
    pageShell('Аналитика обучения','Сводка по записям и завершённым попыткам тестов',`<div class="lms-grid"><div class="card lms-card"><span class="lms-kicker">Зачисления</span><div class="lms-stat">${en.data.length}</div></div><div class="card lms-card"><span class="lms-kicker">Завершённые тесты</span><div class="lms-stat">${att.data.length}</div></div><div class="card lms-card"><span class="lms-kicker">Средний результат</span><div class="lms-stat">${avg}%</div></div><div class="card lms-card"><span class="lms-kicker">Сданы</span><div class="lms-stat">${passed}</div></div></div><div class="card lms-card"><h2>Записи по курсам</h2>${(courses.data||[]).map(c=>{const n=en.data.filter(x=>x.course_id===c.id).length;return `<div class="lms-lesson"><div class="lms-toolbar"><b>${esc(c.title)}</b><b>${n}</b></div><div class="progress-line"><i style="width:${Math.min(100,n*10)}%"></i></div></div>`}).join('')||'<p class="lms-muted">Пока нет курсов.</p>'}</div>`);
  }
  async function loadLearnerTests() {
    const {data:en,error:ee}=await db.from('enrollments').select('course_id').eq('user_id',authUser.id).in('state',['active','completed']);if(ee)return pageShell('Тесты и результаты','Ваши попытки',errCard(statusError(ee)));
    const ids=(en||[]).map(x=>x.course_id);if(!ids.length)return pageShell('Тесты и результаты','Тесты доступны после записи на курс','<div class="card lms-empty">Сначала выберите курс в каталоге.</div>');
    const {data:tests,error}=await db.from('tests').select('id,title,kind,passing_score,course_id,unit_id,courses(title)').eq('status','published').in('course_id',ids);if(error)return pageShell('Тесты и результаты','Модульные и итоговые проверки',errCard(statusError(error)));
    const {data:attempts}=await db.from('lms_test_attempts').select('id,test_id,attempt_number,percentage,passed,submitted_at').eq('user_id',authUser.id).not('submitted_at','is',null);
    pageShell('Тесты и результаты','Результаты и доступные попытки из базы',tests.length?`<div class="lms-grid">${tests.map(t=>{const a=(attempts||[]).filter(x=>x.test_id===t.id).sort((x,y)=>y.attempt_number-x.attempt_number)[0];return `<article class="card lms-item"><span class="lms-kicker">${esc(t.kind)} · проходной балл ${t.passing_score}%</span><h2>${esc(t.title)}</h2><p>${esc(t.courses?.title||'Курс')}</p>${a?`<p>Последний результат: <b>${a.percentage}%</b> · ${a.passed?'пройден':'нужна пересдача'} · попытка ${a.attempt_number}</p>`:'<p>Попыток пока нет.</p>'}<button class="btn btn-primary btn-sm" data-action="lms-start-test" data-test-id="${esc(t.id)}">${a&&!a.passed?'Повторить тест':'Начать тест'}</button></article>`}).join('')}</div>`:'<div class="card lms-empty">Опубликованных тестов нет.</div>');
  }
  async function startTest(id) {
    const {data,error}=await db.rpc('start_lms_test_attempt',{target_test:id});if(error)return notify(statusError(error));activeAttempt=data.attempt_id;activeTest={id};attemptAnswers={};attemptTimeLimit=data.time_limit_minutes?Number(data.time_limit_minutes):null;attemptDeadline=attemptTimeLimit?Date.parse(data.started_at)+attemptTimeLimit*60000:null;submittingAttempt=false;
    const {data:qs,error:qe}=await db.from('lms_questions').select('id,prompt,question_type,points,sort_order,lms_answer_options(id,option_text,sort_order)').eq('test_id',id).order('sort_order');if(qe)return notify(statusError(qe));attemptQuestions=(qs||[]).map(q=>({...q,lms_answer_options:(q.lms_answer_options||[]).sort((a,b)=>a.sort_order-b.sort_order)}));if(!attemptQuestions.length)return notify('В тесте ещё нет вопросов.');renderQuizPage(0);
  }
  function renderQuizPage(index) {
    const q=attemptQuestions[index];if(!q)return;app.question=index;
    if(quizTimer)clearInterval(quizTimer);
    pageShell('Прохождение теста',`Вопрос ${index+1} из ${attemptQuestions.length} · ответы проверяются сервером${attemptTimeLimit?' · лимит '+attemptTimeLimit+' мин':''}`, `<div class="card lms-card lms-section"><div class="lms-toolbar"><span class="lms-kicker">${esc(q.question_type)} · ${q.points} балл.</span>${attemptDeadline?'<b id="lmsCountdown" aria-live="polite"></b>':''}</div><h2>${esc(q.prompt)}</h2><div class="lms-options">${q.lms_answer_options.map(o=>`<label class="lms-option"><input type="${q.question_type==='multiple_choice'?'checkbox':'radio'}" name="lms-answer" value="${esc(o.id)}" ${((attemptAnswers[q.id]||[]).includes(o.id))?'checked':''}><span>${esc(o.option_text)}</span></label>`).join('')}</div><div class="lms-row"><button class="btn btn-outline" data-action="lms-quiz-back" ${index===0?'disabled':''}>Назад</button><button class="btn btn-primary" data-action="lms-quiz-next">${index===attemptQuestions.length-1?'Отправить ответы':'Следующий вопрос'}</button></div></div>`);
    $$('input[name="lms-answer"]').forEach(input=>input.addEventListener('change',()=>{if(q.question_type==='multiple_choice'){let a=attemptAnswers[q.id]||[];a=input.checked?[...new Set([...a,input.value])]:a.filter(x=>x!==input.value);attemptAnswers[q.id]=a;}else attemptAnswers[q.id]=[input.value];}));
    if(attemptDeadline){const tick=()=>{const remaining=Math.max(0,Math.ceil((attemptDeadline-Date.now())/1000));const timer=el('#lmsCountdown');if(timer)timer.textContent=`Осталось ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;if(remaining===0){clearInterval(quizTimer);void submitAttempt(true);}};tick();quizTimer=setInterval(tick,1000);}
  }
  async function submitAttempt(byTimeout=false){if(submittingAttempt)return;submittingAttempt=true;if(quizTimer)clearInterval(quizTimer);const {data,error}=await db.rpc('submit_lms_test_attempt',{target_attempt:activeAttempt,submitted_answers:attemptAnswers});if(error){submittingAttempt=false;notify((byTimeout?'Время истекло. ':'')+statusError(error));return;}app.lastTestResult=data;app.page='lms-result';renderPage();}
  async function uploadForLesson(lessonId,file,title,description) {
    if(!file)throw new Error('Выберите файл');
    const valid=['application/pdf','video/mp4','video/webm','text/markdown','text/plain','image/jpeg','image/png','image/webp'];if(!valid.includes(file.type))throw new Error('Формат файла не поддерживается. Используйте PDF, MP4, WebM, Markdown, TXT или изображение.');
    if(file.size>512*1024*1024)throw new Error('Размер файла превышает заданный лимит 512 МБ.');
    const safe=file.name.normalize('NFKD').replace(/[^\w.-]+/g,'_').slice(-120);const path=`${authUser.id}/${activeCourse.id}/${lessonId}/${Date.now()}_${safe}`;
    const {error:upError}=await db.storage.from('course-materials').upload(path,file,{contentType:file.type,upsert:false});if(upError)throw upError;
    const type=file.type.startsWith('video/')?'video':file.type==='application/pdf'?'lecture':file.type.startsWith('image/')?'interactive_model':'notes';
    const {data:material,error:me}=await db.from('library_materials').insert({organization_id:activeCourse.organization_id||null,title,description:description||'',material_type:type,storage_path:path,mime_type:file.type,byte_size:file.size,author_id:authUser.id,status:'published',allow_download:false}).select('id').single();
    if(me){await db.storage.from('course-materials').remove([path]);throw me;}
    const {error:linkError}=await db.from('lesson_materials').insert({lesson_id:lessonId,material_id:material.id,sort_order:0});if(linkError)throw linkError;
  }

  renderPage=function() {
    renderNav();
    if(!authUser){
      if(String(app.page).startsWith('lms-')){pageShell('Войдите в DentAcademy','Для доступа к серверным курсам и результатам нужен аккаунт Supabase','<div class="card lms-empty"><h2>Демо и учебная база разделены</h2><p>Войдите или зарегистрируйтесь, чтобы работать с данными Supabase.</p><div class="lms-row" style="justify-content:center"><button class="btn btn-primary" data-action="lms-login">Войти</button><button class="btn btn-outline" data-action="lms-register">Регистрация</button></div></div>');return;}
      originalRenderPage();renderNav();return;
    }
    switch(app.page){
      case 'lms-dashboard': void renderDashboard(); break;
      case 'lms-catalog': void loadCatalog(false); break;
      case 'lms-my-courses': void loadCatalog(true); break;
      case 'lms-course': activeCourse?.id?void openCourse(activeCourse.id):pageShell('Курс','', '<div class="card lms-empty">Выберите курс.</div>');break;
      case 'lms-lesson': app.lessonId?void openLesson(app.lessonId):pageShell('Урок','', '<div class="card lms-empty">Урок не выбран.</div>');break;
      case 'lms-courses': void loadAdminCourses(); break;
      case 'lms-course-editor': activeCourse?.id?void adminCourse(activeCourse.id):void loadAdminCourses();break;
      case 'lms-tests': app.role==='admin'?void loadAdminTests():void loadLearnerTests();break;
      case 'lms-test-editor': activeTest?.id?void editTest(activeTest.id):void loadAdminTests();break;
      case 'lms-quiz': renderQuizPage(app.question||0);break;
      case 'lms-users': app.role==='admin'?void loadAdminUsers():pageShell('Пользователи','', '<div class="card lms-empty">Нет доступа.</div>');break;
      case 'lms-analytics': app.role==='admin'?void loadAnalytics():pageShell('Аналитика','', '<div class="card lms-empty">Нет доступа.</div>');break;
      case 'lms-result': pageShell('Результат теста','Попытка сохранена в Supabase',`<div class="card lms-card"><h2>${app.lastTestResult?.passed?'Тест пройден':'Тест не пройден'}</h2><div class="lms-stat">${app.lastTestResult?.percentage??0}%</div><p>Баллы: ${app.lastTestResult?.score??0} из ${app.lastTestResult?.max_score??0}</p><button class="btn btn-primary" data-page="lms-tests">К тестам и результатам</button></div>`);break;
      case 'profile': case 'settings': originalRenderPage(); renderNav(); break;
      default: pageShell('Раздел обновляется','Наставничество, клинические допуски и демо-экраны не входят в текущую LMS-версию',`<div class="card lms-empty"><p>Используйте разделы обучения или управления LMS в меню слева.</p><button class="btn btn-primary" data-page="lms-dashboard">К обзору</button></div>`);
    }
  };

  modalForAction=function(action,button){
    const id=button?.dataset.courseId;
    if(action==='lms-login'){authModal('login');return;}
    if(action==='lms-register'){authModal('register');return;}
    if(action==='lms-logout'){if(!db)return notify('Supabase SDK не загрузился. Обновите страницу.');db.auth.signOut().then(({error})=>{if(error)return notify(statusError(error));authUser=null;app.role='learner';app.profile={...savedDemoProfile};app.page='dashboard';renderNav();renderPage();notify('Вы вышли из аккаунта');});return;}
    if(action==='lms-refresh'){renderPage();return;}
    if(action==='lms-course-preview'){activeCourse={id};openCourse(id);return;}
    if(action==='lms-open-course'){activeCourse={id};app.page='lms-course';renderPage();return;}
    if(action==='lms-enroll'){db.rpc('enroll_in_course',{target_course:id}).then(({error})=>{if(error)return notify(statusError(error));activeCourse={id};app.page='lms-my-courses';renderPage();notify('Вы записаны на курс');});return;}
    if(action==='lms-admin-course'){activeCourse={id};app.page='lms-course-editor';renderPage();return;}
    if(action==='lms-publish-course'){void publishCourse(id);return;}
    if(action==='lms-publish-module'){db.from('course_units').update({status:'published'}).eq('id',button.dataset.moduleId).then(({error})=>{if(error)return notify(statusError(error));notify('Модуль опубликован');renderPage();});return;}
    if(action==='lms-publish-lesson'){db.from('lessons').update({status:'published'}).eq('id',button.dataset.lessonId).then(({error})=>{if(error)return notify(statusError(error));notify('Урок опубликован');renderPage();});return;}
    if(action==='lms-upload-lesson'){const lessonId=button.dataset.lessonId;openModal('Файл к уроку',`<form id="lmsUploadForm" class="lms-form"><div class="field"><label>Название *</label><input name="title" required></div><div class="field"><label>Описание</label><textarea name="description" rows="2"></textarea></div><div class="field"><label>PDF, MP4, WebM, Markdown, TXT или изображение *</label><input name="file" type="file" accept=".pdf,.mp4,.webm,.md,.txt,image/jpeg,image/png,image/webp" required></div><p class="lms-muted">Файл сохранится в приватном Supabase Storage и прикрепится к этому уроку. Максимум 512 МБ.</p></form>`,'<button class="btn btn-outline" data-action="close-modal">Отмена</button><button class="btn btn-primary" data-action="lms-upload-save">Загрузить и прикрепить</button>');el('#lmsUploadForm').dataset.lessonId=lessonId;return;}
    if(action==='lms-add-option'){const form=el('#lmsQuestionForm'),rows=form?.querySelectorAll('[data-option-row]')||[];if(rows.length>=8)return notify('Максимум 8 вариантов ответа.');const n=rows.length+1;const row=document.createElement('label');row.className='lms-option';row.dataset.optionRow=n;row.innerHTML=`<input type="checkbox" name="correct" value="${n}"><input name="option${n}" placeholder="Вариант ${n}" required>`;form.querySelector('.lms-options')?.append(row);return;}
    if(action==='lms-lesson'){app.lessonId=button.dataset.lessonId;app.page='lms-lesson';renderPage();return;}
    if(action==='lms-back-course'){app.page='lms-course';renderPage();return;}
    if(action==='lms-mark-lesson'){const lessonId=button.dataset.lessonId;db.rpc('mark_lesson_complete',{target_lesson:lessonId}).then(({data,error})=>{if(error)return notify(statusError(error));notify(data.course_completed?'Курс завершён. Результат сохранён.':`Прогресс сохранён: ${data.completed_lessons} из ${data.total_lessons} уроков`);renderPage();});return;}
    if(action==='lms-edit-test'){activeTest={id:button.dataset.testId};app.page='lms-test-editor';renderPage();return;}
    if(action==='lms-publish-test'){db.from('tests').update({status:'published'}).eq('id',button.dataset.testId).then(({error})=>{if(error)return notify(statusError(error));notify('Тест опубликован');renderPage();});return;}
    if(action==='lms-start-test'){void startTest(button.dataset.testId);return;}
    if(action==='lms-quiz-back'){renderQuizPage(Math.max(0,(app.question||0)-1));return;}
    if(action==='lms-quiz-next'){const q=attemptQuestions[app.question||0];if(!attemptAnswers[q.id]?.length){notify('Выберите ответ');return;}if((app.question||0)<attemptQuestions.length-1){renderQuizPage(app.question+1);return;}void submitAttempt(false);return;}
    if(action==='lms-signup'){if(!db)return notify('Supabase SDK не загрузился. Обновите страницу.');const name=el('#authName')?.value.trim(),email=el('#authEmail')?.value.trim(),password=el('#authPassword')?.value,specialty=el('#authSpecialty')?.value.trim()||'',learner_status=el('#authAccountType')?.value||'student',experience_raw=el('#authExperience')?.value,experience_years=experience_raw===''?null:Number(experience_raw);if(!name||!email||!el('#authEmail')?.checkValidity()||!password||password.length<8)return notify('Проверьте ФИО, почту и пароль от 8 символов.');if(experience_years!==null&&(!Number.isInteger(experience_years)||experience_years<0||experience_years>80))return notify('Стаж должен быть от 0 до 80 лет.');db.auth.signUp({email,password,options:{data:{full_name:name,specialty,learner_status,experience_years}}}).then(async({data,error})=>{if(error)return notify('Ошибка регистрации: '+statusError(error));if(data.session&&data.user){await db.from('profiles').update({full_name:name,specialty,learner_status,experience_years}).eq('id',data.user.id);closeModal();await loadAuthProfile(data.user);notify('Аккаунт создан');}else{openModal('Подтвердите почту','<p>Откройте письмо Supabase, подтвердите адрес и затем войдите в аккаунт.</p>','<button class="btn btn-primary" data-auth="login">Перейти ко входу</button>');}});return;}
    if(action==='auth-submit'&&app.authMode==='register'){notify('Для регистрации используйте форму обучающегося.');return;}
    if(action==='auth-submit'&&app.authMode==='login'){if(!db)return notify('Supabase SDK не загрузился. Обновите страницу.');const email=el('#authEmail')?.value.trim(),password=el('#authPassword')?.value;if(!email||!password)return notify('Введите почту и пароль.');db.auth.signInWithPassword({email,password}).then(async({data,error})=>{if(error)return notify(statusError(error));closeModal();await loadAuthProfile(data.user);notify('Вход выполнен');});return;}
    if(action==='auth-submit'&&app.authMode==='forgot'){if(!db)return notify('Supabase SDK не загрузился. Обновите страницу.');const email=el('#authEmail')?.value.trim();if(!email||!el('#authEmail')?.checkValidity())return notify('Введите корректную почту.');db.auth.resetPasswordForEmail(email,{redirectTo:location.href.split('#')[0]}).then(({error})=>error?notify(statusError(error)):openModal('Проверьте почту','<p>Если такой аккаунт существует, Supabase отправит ссылку для сброса пароля.</p>'));return;}
    if(action==='save-account'&&authUser){const name=el('#accountName')?.value.trim(),specialty=el('#accountSpecialty')?.value.trim()||'',region=el('#accountRegionCustom')?.value.trim()||el('#accountRegion')?.value||'';if(!name)return notify('Введите ФИО.');db.from('profiles').update({full_name:name,specialty,region,city:region}).eq('id',authUser.id).then(({error})=>{if(error)return notify(statusError(error));app.profile.name=name;app.profile.specialty=specialty;app.profile.region=region;notify('Профиль сохранён');renderNav();renderPage();});return;}
    if(action==='lms-upload-save'){const form=el('#lmsUploadForm'),file=form?.elements.file.files[0],title=form?.elements.title.value.trim(),description=form?.elements.description.value.trim();if(!form||!title||!file)return notify('Заполните название и выберите файл.');const save=el('#modalContent [data-action="lms-upload-save"]');setBusy(save,true);uploadForLesson(form.dataset.lessonId,file,title,description).then(()=>{closeModal();notify('Материал загружен и прикреплён к уроку');renderPage();}).catch(e=>notify(statusError(e))).finally(()=>setBusy(save,false));return;}
    originalModalAction(action,button);
  };

  document.addEventListener('submit',async e=>{
    const form=e.target;
    if(form.id==='lmsCourseForm'){e.preventDefault();const fd=new FormData(form),directionName=String(fd.get('direction')||'').trim();let direction_id=null;if(directionName){const {data:d,error:de}=await db.from('directions').select('id').ilike('title',directionName).limit(1).maybeSingle();if(de)return notify(statusError(de));if(d)direction_id=d.id;else{const {data:newDirection,error:ne}=await db.from('directions').insert({title:directionName,slug:'direction-'+crypto.randomUUID(),status:'published',created_by:authUser.id}).select('id').single();if(ne)return notify(statusError(ne));direction_id=newDirection.id;}}const {data,error}=await db.from('courses').insert({title:fd.get('title'),description:fd.get('description')||'',level:fd.get('level'),direction_id,test_required:fd.get('test_required')==='on',author_id:authUser.id,status:'draft'}).select('id').single();if(error)return notify(statusError(error));activeCourse={id:data.id};notify('Черновик курса создан');app.page='lms-course-editor';renderPage();return;}
    if(form.id==='lmsPrerequisiteForm'){e.preventDefault();const required_course_id=new FormData(form).get('required_course_id');if(!required_course_id)return;const {error}=await db.from('course_prerequisites').insert({course_id:activeCourse.id,required_course_id});if(error)return notify(statusError(error));notify('Пререквизит добавлен');renderPage();return;}
    if(form.id==='lmsAssignmentForm'){e.preventDefault();const target=String(new FormData(form).get('target_id')||''),[kind,targetId]=target.split(':');if(!targetId)return;const {data:latest,error:te}=await db.from('tests').select('settings').eq('id',activeTest.id).single();if(te)return notify(statusError(te));const {error:ae}=await db.from('test_assignments').insert({test_id:activeTest.id,user_id:kind==='user'?targetId:null,group_id:kind==='group'?targetId:null});if(ae)return notify(statusError(ae));const {error:ue}=await db.from('tests').update({settings:{...(latest.settings||{}),assign_all_enrollments:false}}).eq('id',activeTest.id);if(ue)return notify(statusError(ue));notify('Назначение добавлено');renderPage();return;}
    const unitId=form.dataset.lessonForm;if(unitId){e.preventDefault();const fd=new FormData(form);const {data:prior}=await db.from('lessons').select('sort_order').eq('unit_id',unitId).order('sort_order',{ascending:false}).limit(1);const {error}=await db.from('lessons').insert({unit_id:unitId,title:fd.get('title'),body:fd.get('body')||'',content_markdown:fd.get('body')||'',sort_order:(prior?.[0]?.sort_order??-1)+1,status:'draft'});if(error)return notify(statusError(error));notify('Урок добавлен');renderPage();return;}
    if(form.id==='lmsModuleForm'){e.preventDefault();const fd=new FormData(form);const {data:prior}=await db.from('course_units').select('sort_order').eq('course_id',activeCourse.id).order('sort_order',{ascending:false}).limit(1);const {error}=await db.from('course_units').insert({course_id:activeCourse.id,title:fd.get('title'),description:fd.get('description')||'',sort_order:(prior?.[0]?.sort_order??-1)+1,status:'draft'});if(error)return notify(statusError(error));notify('Модуль добавлен');renderPage();return;}
    if(form.id==='lmsTestForm'){e.preventDefault();const fd=new FormData(form);const {data,error}=await db.from('tests').insert({title:fd.get('title'),course_id:fd.get('course_id'),unit_id:fd.get('unit_id')||null,kind:fd.get('kind'),passing_score:Number(fd.get('passing_score')),settings:{max_attempts:Number(fd.get('max_attempts')),time_limit_minutes:fd.get('time_limit_minutes')?Number(fd.get('time_limit_minutes')):null,shuffle_questions:true,shuffle_options:true,assign_all_enrollments:true}}).select('id').single();if(error)return notify(statusError(error));activeTest={id:data.id};notify('Черновик теста создан');app.page='lms-test-editor';renderPage();return;}
    if(form.id==='lmsQuestionForm'){e.preventDefault();const fd=new FormData(form),optionRows=[...form.querySelectorAll('[data-option-row]')],checked=[...form.querySelectorAll('input[name="correct"]:checked')].map(x=>Number(x.value)),options=optionRows.map((row,i)=>({option_text:String(fd.get(`option${i+1}`)||'').trim(),is_correct:checked.includes(i+1),sort_order:i})).filter(x=>x.option_text);if(options.length<2||!options.some(x=>x.is_correct))return notify('Добавьте минимум два варианта и отметьте правильный ответ.');if(fd.get('question_type')==='single_choice'&&options.filter(x=>x.is_correct).length!==1)return notify('Для одного ответа отметьте ровно один правильный вариант.');const {data:q,error}=await db.from('lms_questions').insert({test_id:activeTest.id,prompt:fd.get('prompt'),question_type:fd.get('question_type'),points:Number(fd.get('points')||1),sort_order:Date.now()}).select('id').single();if(error)return notify(statusError(error));const rows=options.map((x,i)=>({...x,question_id:q.id,sort_order:i}));const {error:oe}=await db.from('lms_answer_options').insert(rows);if(oe)return notify(statusError(oe));notify('Вопрос сохранён');renderPage();}
  });

  // Handle all navigation paths without trusting browser role state.
  document.addEventListener('click',e=>{
    const auth=e.target.closest('#lmsAuthButtons [data-action]');if(auth){e.preventDefault();e.stopImmediatePropagation();modalForAction(auth.dataset.action,auth);return;}
    const nav=e.target.closest('[data-page]');if(nav&&nav.dataset.page?.startsWith('lms-')){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();app.page=nav.dataset.page;renderPage();el('#sidebar')?.classList.remove('open');}
    if(e.target.closest('#accountBtn')){app.page='profile';renderPage();}
  },true);

  renderNav();
  if(db){
    db.auth.getSession().then(({data,error})=>{if(error)console.warn('Supabase session restore:',error.message);if(data?.session?.user)loadAuthProfile(data.session.user);else{authUser=null;app.role='learner';renderNav();}});
    db.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_IN'&&session?.user)queueMicrotask(()=>loadAuthProfile(session.user));if(event==='SIGNED_OUT'){authUser=null;app.role='learner';app.page='dashboard';renderNav();}});
  }
})();
