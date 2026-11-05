// Git-specific layout and diff rendering. Controls reuse workbench classes;
// colors come from the same DSH theme tokens as the other feature pages.

export const CSS = `
.wb-git-root{width:100%;flex:1;position:relative;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;
  gap:8px;padding:10px 24px 20px;
  background:var(--wb-git-page);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family);font-size:13px;line-height:20px;
  --wb-accent:var(--dsw-alias-brand-primary,#6366f1);
  --wb-accent-bg:color-mix(in srgb,var(--wb-accent) 10%,transparent);
  --wb-git-accent:var(--wb-accent);
  --wb-git-accent-strong:var(--wb-accent);
  --wb-git-accent-soft:var(--wb-accent-bg);
  --wb-git-page:var(--dsw-alias-bg-base);
  --wb-git-card:var(--dsw-alias-bg-layer-1);
  --wb-git-rail-bg:var(--dsw-alias-bg-layer-1);
  --wb-git-line:var(--dsw-alias-border-l2);
  --wb-git-line-soft:color-mix(in srgb, var(--dsw-alias-border-l2) 55%, transparent);
  --wb-git-ok:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, var(--dsw-alias-label-primary));
  --wb-git-warn:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 58%, var(--dsw-alias-label-primary));
  --wb-git-err:color-mix(in srgb, var(--dsw-alias-state-error-primary) 70%, var(--dsw-alias-label-primary));
  --wb-git-meta:var(--dsw-alias-label-secondary);
  --wb-git-lane-0:var(--wb-git-accent);
  --wb-git-lane-1:color-mix(in srgb, var(--dsw-alias-state-success-primary) 80%, var(--dsw-alias-label-primary));
  --wb-git-lane-2:var(--dsw-alias-state-warn-primary);
  --wb-git-lane-3:var(--dsw-alias-state-error-primary);
  --wb-git-lane-4:var(--dsw-alias-label-primary-bluish);}

.wb-git-root button{white-space:nowrap}

.wb-git-commit-dialog{display:flex;flex-direction:column;width:min(1100px,96vw);height:min(760px,90vh);min-height:0;overflow:hidden;border-radius:14px;background:var(--dsw-alias-bg-layer-1);}
.wb-git-commit-title{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;}
.wb-git-commit-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* One surface for toolbar and workspace. */
.wb-git-surface{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;
  border:1px solid var(--wb-git-line);border-radius:9px;background:var(--wb-git-card);}
/* toolbar */
.wb-git-root .wb-git-topbar{display:flex;justify-content:flex-start;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;min-height:38px;padding:0 10px;
  border:0;border-bottom:1px solid var(--wb-git-line-soft);border-radius:0;background:var(--wb-git-card);}
.wb-git-right>.wb-git-topbar{margin:0 -6px;padding:4px 6px;}
/* Shared controls only need Git-specific sizing constraints. */
.wb-git-root .wb-git-branch-select{flex:0 1 160px;width:160px;min-width:70px;max-width:230px;}
.wb-git-iconbtn:disabled{opacity:.5;cursor:default;}
.wb-git-search-input{flex:1 1 0;width:0;min-width:0;}
.wb-workbench .wb-git-commit-input{flex:none;width:100%;height:144px;min-height:100px;max-height:32vh;resize:vertical;}
.wb-git-commit-toggle{margin-left:auto;flex:0 0 auto;}
.wb-git-ai-chip{max-width:180px;}
.wb-git-root .wb-git-row .wb-git-rowact{flex:0 0 auto;margin-left:auto;display:none;}
/* branch / sync pills */
.wb-git-refs{display:flex;flex:1 1 240px;align-items:center;gap:6px;min-width:0;}
.wb-git-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:999px;
  background:var(--wb-git-accent-soft);color:var(--wb-git-accent-strong);font-size:11px;line-height:1;white-space:nowrap;}
.wb-git-chip[data-tone='muted']{background:var(--wb-git-line-soft);color:var(--dsw-alias-label-secondary);}
.wb-git-chip[data-tone='ok']{color:var(--wb-git-ok);background:var(--wb-git-line-soft);}
.wb-git-chip[data-tone='warn']{color:var(--wb-git-warn);background:var(--wb-git-line-soft);}
.wb-git-upstream{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;min-width:0;flex:1 1 auto;}
.wb-git-actions{display:flex;align-items:center;gap:2px;margin-left:8px;flex-shrink:0;}
.wb-git-iconbtn[data-busy='true'] svg{animation:wb-git-spin .9s linear infinite;}
@keyframes wb-git-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wb-git-iconbtn[data-busy='true'] svg{animation:none}}

/* workspace */
.wb-git-body{display:flex;flex:1 1 auto;min-height:0;border:0;border-radius:0;
  overflow:hidden;background:var(--wb-git-card);}

/* rail */
.wb-git-rail{box-sizing:border-box;flex:0 0 130px;min-width:0;display:flex;flex-direction:column;overflow:auto;
  padding:8px 6px;border-right:1px solid var(--wb-git-line-soft);background:var(--wb-git-rail-bg);}
.wb-git-rail-title{display:flex;align-items:center;justify-content:space-between;height:26px;padding:0 8px;
  margin-top:12px;color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-rail-title:first-child{margin-top:0;}
.wb-git-rail-title-right{display:inline-flex;align-items:center;gap:6px;}
.wb-git-rail-add{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);
  font:inherit;font-size:14px;line-height:1;cursor:pointer;}
.wb-git-rail-add:hover{background:var(--wb-git-line-soft);color:var(--dsw-alias-label-primary);}
.wb-git-rail-row{display:flex;align-items:center;gap:8px;height:32px;padding:0 9px;border-radius:9px;
  color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:nowrap;}
.wb-git-rail-row[data-active='true']{background:var(--wb-git-accent-soft);color:var(--wb-git-accent-strong);font-weight:600;}
.wb-git-rail-row[data-current='true']{color:var(--dsw-alias-label-primary);font-weight:500;}
.wb-git-rail-row[data-muted='true']{color:var(--dsw-alias-label-tertiary);}
.wb-git-rail-icon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);flex:0 0 auto;width:13px;}
.wb-git-rail-row[data-current='true'] .wb-git-rail-icon{color:var(--wb-git-accent-strong);}
.wb-git-rail-row[data-active='true'] .wb-git-rail-icon{color:var(--wb-git-accent-strong);}
.wb-git-rail-dot{width:6px;height:6px;border-radius:50%;background:var(--wb-git-accent);flex:0 0 auto;}
.wb-git-rail-name{overflow:hidden;text-overflow:ellipsis;}
.wb-git-rail-empty{padding:3px 9px 5px;color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-rail-btn{appearance:none;border:0;width:100%;background:transparent;text-align:left;
  font:inherit;font-size:12.5px;cursor:pointer;}
.wb-git-rail-ref{position:relative;cursor:pointer;}
.wb-git-rail-ref:hover{background:var(--wb-git-line-soft);}
.wb-git-rail-ref[data-menu='true']{background:var(--wb-git-line-soft);}
.wb-git-rail-ref .wb-git-rail-more{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
  margin-left:auto;padding:0;border:0;border-radius:5px;background:transparent;
  color:var(--dsw-alias-label-tertiary);opacity:0;cursor:pointer;}
.wb-git-rail-ref:hover .wb-git-rail-more,.wb-git-rail-ref:focus-within .wb-git-rail-more,
.wb-git-rail-ref[data-menu='true'] .wb-git-rail-more{opacity:1;}
.wb-git-rail-more:hover{background:var(--wb-git-line-soft);color:var(--dsw-alias-label-primary);}

/* panes */
.wb-git-main{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}
.wb-git-panes{display:flex;flex:1 1 auto;min-height:0;min-width:0;}
.wb-git-list{display:flex;flex-direction:column;flex:0 0 240px;min-width:0;min-height:0;border-right:1px solid var(--wb-git-line-soft);}
.wb-git-right{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;padding:0 6px;}
.wb-git-diff{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}

/* change list */
.wb-git-group-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-weight:400;font-size:11px;}
.wb-git-row{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;height:36px;
  padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12.5px;text-align:left;cursor:default;}
.wb-git-row:hover{background:var(--wb-git-line-soft);}
.wb-git-row:focus-visible{outline:2px solid var(--wb-git-accent);outline-offset:-2px;}
.wb-git-row[data-active='true']{background:var(--wb-git-accent-soft);}
.wb-git-row[data-active='true'] .wb-git-path-name{font-weight:600;}
.wb-git-row[data-menu='true']{background:var(--wb-git-line-soft);}
.wb-git-check{flex:0 0 auto;width:14px;height:14px;margin:0;accent-color:var(--wb-git-accent-strong);cursor:pointer;}
.wb-git-badge{flex:0 0 auto;display:inline-grid;place-items:center;width:16px;height:16px;border-radius:5px;
  font-family:var(--ds-font-family-code);font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  background:var(--wb-git-line-soft);}
.wb-git-badge[data-tone='ok']{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, var(--wb-git-card));color:var(--wb-git-ok);}
.wb-git-badge[data-tone='warn']{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, var(--wb-git-card));color:var(--wb-git-warn);}
.wb-git-badge[data-tone='error']{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--wb-git-card));color:var(--wb-git-err);}
.wb-git-badge[data-tone='accent']{background:var(--wb-git-accent-soft);color:var(--wb-git-accent-strong);}
.wb-git-badge[data-tone='muted']{background:var(--wb-git-line-soft);color:var(--dsw-alias-label-secondary);}
.wb-git-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.wb-git-path-dir{color:var(--dsw-alias-label-tertiary);}
.wb-git-path-name{color:var(--dsw-alias-label-primary);}
.wb-git-root .wb-git-row:hover .wb-git-rowact,.wb-git-root .wb-git-row:focus-within .wb-git-rowact{display:inline-flex;}
@media (hover:none){.wb-git-root .wb-git-row .wb-git-rowact{display:inline-flex;}}
.wb-git-rowact[data-disabled]{opacity:1;color:var(--wb-git-warn);cursor:default;}

/* diff */
.wb-git-diff-head{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-height:38px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.wb-git-diff-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary);font-weight:600;}
.wb-git-diff-orig{color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-stats{display:flex;flex:none;gap:6px;font-size:11px;font-variant-numeric:tabular-nums;}
.wb-git-stat-add{color:var(--wb-git-ok);font-weight:500;}
.wb-git-stat-del{color:var(--wb-git-err);font-weight:500;}
.wb-git-diff-body{flex:1 1 auto;min-height:0;overflow:auto;}
.wb-git-placeholder{padding:14px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.wb-git-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
  height:100%;min-height:120px;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.wb-git-empty-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;}

/* history */
.wb-git-history{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;padding:0 6px;}
.wb-git-htoolbar{display:flex;align-items:center;gap:10px;flex:0 0 auto;height:46px;}
.wb-git-seg{display:inline-flex;padding:2px;border-radius:9px;background:var(--wb-git-line-soft);}
.wb-git-seg-btn{appearance:none;border:0;height:26px;padding:0 11px;border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;}
.wb-git-seg-btn:hover{color:var(--dsw-alias-label-primary);}
.wb-git-seg-btn[data-active]{background:var(--wb-git-card);color:var(--wb-git-accent-strong);font-weight:600;
  }
.wb-git-resultcount{margin-left:10px;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;}
.wb-git-searchbar{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;margin-left:auto;justify-content:flex-end;}
.wb-git-filter{display:flex;align-items:center;gap:6px;min-width:0;}
.wb-git-filter>span{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}
.wb-git-filter-narrow{flex:0 1 190px;}
.wb-git-scope{display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 4px 0 9px;border-radius:999px;
  background:var(--wb-git-accent-soft);color:var(--wb-git-accent-strong);font-size:11px;}
.wb-git-scope-clear{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;
  font:inherit;font-size:13px;line-height:1;padding:0 3px;}
.wb-git-hhead{display:grid;grid-template-columns:88px minmax(0,1fr) 132px 84px 108px 138px;align-items:center;
  flex:0 0 auto;height:30px;color:var(--dsw-alias-label-tertiary);font-size:11px;
  border-top:1px solid var(--wb-git-line-soft);border-bottom:1px solid var(--wb-git-line-soft);}
.wb-git-hscroll{flex:1 1 auto;min-height:0;overflow:auto;}
.wb-git-hlist{padding:4px 0 10px;}
.wb-git-hrow{box-sizing:border-box;display:grid;grid-template-columns:88px minmax(0,1fr) 132px 84px 108px 138px;
  align-items:center;height:32px;padding:0 4px;border-radius:9px;color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:default;}
.wb-git-hrow:hover{background:var(--wb-git-line-soft);}
.wb-git-hrow[data-active]{background:var(--wb-git-accent-soft);}
.wb-git-hrow[data-active] .wb-git-hsubject-text{font-weight:600;}
.wb-git-hrow:focus-visible{outline:2px solid var(--wb-git-accent);outline-offset:-2px;}
.wb-git-hgraph{display:flex;align-items:center;overflow:visible;}
.wb-git-graph{display:block;overflow:visible;}
.wb-git-hsubject{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;}
.wb-git-hsubject-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wb-git-hrefs{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;}
.wb-git-refchip{flex:0 0 auto;padding:0 7px;border-radius:999px;line-height:17px;font-size:11px;
  color:var(--wb-git-accent-strong);background:var(--wb-git-accent-soft);border:1px solid transparent;}
.wb-git-refchip[data-kind='tag']{color:var(--dsw-alias-label-secondary);background:var(--wb-git-line-soft);}
.wb-git-refchip[data-kind='more']{color:var(--dsw-alias-label-tertiary);background:transparent;border-color:var(--wb-git-line);}
.wb-git-hsha{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);}
.wb-git-hauthor,.wb-git-hdate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);font-size:11px;}
.wb-git-hmore{display:flex;justify-content:center;padding:12px;}
.wb-git-detail{flex:0 0 50%;max-height:60%;display:flex;min-height:0;margin-top:10px;
  border:1px solid var(--wb-git-line);border-radius:12px;background:var(--wb-git-card);overflow:hidden;}
.wb-git-detail-side{flex:0 0 340px;min-width:0;display:flex;flex-direction:column;overflow:hidden;
  border-right:1px solid var(--wb-git-line-soft);}
.wb-git-detail-meta{flex:0 1 auto;min-height:0;max-height:45%;overflow:auto;display:flex;flex-direction:column;gap:3px;padding:8px 12px;
  border-bottom:1px solid var(--wb-git-line-soft);}
.wb-git-detail-meta>*{flex-shrink:0;overflow-wrap:anywhere;}
.wb-git-detail-subject{font-size:13px;font-weight:600;white-space:normal;}
.wb-git-detail-sha{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);}
.wb-git-detail-line{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);}
.wb-git-detail-label{color:var(--dsw-alias-label-tertiary);}
.wb-git-link{appearance:none;border:0;background:transparent;padding:0 2px;color:var(--wb-git-accent-strong);
  font:inherit;font-family:var(--ds-font-family-code);font-size:11px;text-decoration:underline;cursor:pointer;}
.wb-git-detail-body{margin:4px 0 0;padding:0;white-space:pre-wrap;
  font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);}
.wb-git-detail-head{flex:0 0 auto;display:flex;align-items:center;height:30px;padding:0 14px;
  color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-detail-list{flex:1 1 auto;min-height:0;overflow:auto;padding:2px 8px 8px;}
.wb-git-detail-file{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.wb-git-detail-file:hover{background:var(--wb-git-line-soft);}
.wb-git-detail-file[data-active]{background:var(--wb-git-accent-soft);}
.wb-git-detail-letter{flex:0 0 auto;width:14px;text-align:center;font-family:var(--ds-font-family-code);
  font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);}
.wb-git-detail-letter[data-status='added']{color:var(--wb-git-ok);}
.wb-git-detail-letter[data-status='deleted']{color:var(--wb-git-err);}
.wb-git-detail-letter[data-status='modified']{color:var(--wb-git-warn);}
.wb-git-detail-letter[data-status='renamed']{color:var(--wb-git-accent-strong);}
.wb-git-detail-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  direction:rtl;text-align:left;}
.wb-git-detail-diff{flex:1 1 auto;min-width:0;overflow:auto;}

/* commit card */
.wb-git-commit{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;margin-top:0;padding:8px 0;
  border:0;border-top:1px solid var(--wb-git-line);border-radius:0;background:var(--wb-git-card);}
/* Folded: one strip that gives the diff the space back. Clicking it unfolds.
   The body keeps its DOM so 0fr → 1fr can animate the height without measuring;
   folded it is inert, so the hidden controls leave the tab order too. */
.wb-git-commit{transition:padding .22s cubic-bezier(.2,.8,.2,1),gap .22s cubic-bezier(.2,.8,.2,1),
  box-shadow .22s ease;}
.wb-git-commit-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .22s cubic-bezier(.2,.8,.2,1);}
.wb-git-commit-body[data-folded='true']{grid-template-rows:0fr;}
.wb-git-commit-body-inner{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:8px;
  opacity:1;transition:opacity .18s ease .05s;}
.wb-git-commit-body[data-folded='true'] .wb-git-commit-body-inner{opacity:0;transition:opacity .1s ease;}
.wb-git-commit[data-collapsed]{padding:7px 10px 7px 12px;gap:0;box-shadow:none;}
.wb-git-commit[data-collapsed] .wb-git-commit-meta{width:100%;gap:9px;cursor:pointer;min-height:24px;}
.wb-git-directory-caret{display:inline-flex;vertical-align:middle;margin-right:4px;color:var(--dsw-alias-label-primary);}
.wb-git-directory-caret[data-folded]{transform:rotate(-90deg);}
.wb-git-commit-caret{display:inline-flex;color:var(--dsw-alias-label-primary);line-height:1;transition:transform .22s cubic-bezier(.2,.8,.2,1);}
.wb-git-commit[data-collapsed] .wb-git-commit-caret{transform:rotate(180deg);}
@media (prefers-reduced-motion:reduce){
  .wb-git-commit,.wb-git-commit-body,.wb-git-commit-body-inner,.wb-git-commit-caret{transition:none;}}
.wb-git-commit-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}
.wb-git-avatar{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;
  background:var(--wb-git-accent-soft);color:var(--wb-git-accent-strong);font-size:11px;font-weight:600;flex:0 0 auto;}
.wb-git-commit-author{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wb-git-commit-branch{color:var(--dsw-alias-label-tertiary);}
.wb-git-commit-branch[data-tone='error']{color:var(--wb-git-err);}
.wb-git-commit-label{display:flex;align-items:center;justify-content:space-between;margin-top:2px;
  font-size:11px;color:var(--dsw-alias-label-tertiary);}
/* AI commit message: one quiet action plus the model chip it calls */
.wb-git-ai{position:relative;display:flex;align-items:center;gap:4px;}
.wb-git-ai-generate svg{width:11px;height:11px;flex:0 0 auto;}
.wb-git-ai-generate[data-busy='true'] svg{animation:wb-git-spin 1.4s linear infinite;}
.wb-git-ai-chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wb-git-ai-caret{font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary);}
.wb-git-ai-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:45;width:min(360px,64vw);
  max-height:min(340px,52vh);overflow:auto;padding:6px;border:1px solid var(--wb-git-line);border-radius:12px;
  background:var(--wb-git-card);box-shadow:0 14px 34px var(--dsw-alias-bg-mask-1);scrollbar-width:thin;}
/* The menu is viewport-fixed (see CommitBox): the fold row clips the card body,
   and a clipped dropdown reads as a broken control. */
.wb-git-ai-menu[data-floating='true']{position:fixed;right:auto;bottom:auto;z-index:90;
  max-height:min(360px,50vh);}
.wb-git-ai-menu-head{padding:4px 8px 6px;border-bottom:1px solid var(--wb-git-line-soft);margin-bottom:4px;
  color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-ai-menu-empty{padding:8px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;}
.wb-git-ai-group{padding:2px 0;}
.wb-git-ai-group-title{padding:4px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:11px;
  text-transform:none;letter-spacing:.02em;}
.wb-git-ai-option{display:flex;align-items:center;gap:7px;width:100%;padding:5px 8px;border:0;border-radius:7px;
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.wb-git-ai-option:hover{background:var(--wb-git-accent-soft);}
.wb-git-ai-option[data-current]{background:var(--wb-git-accent-soft);}
.wb-git-ai-option-check{width:12px;flex:0 0 auto;color:var(--wb-git-accent-strong);font-size:11px;}
.wb-git-ai-option-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wb-git-ai-option-id{flex:0 0 auto;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-ai-menu-failure{padding:6px 8px 2px;border-top:1px solid var(--wb-git-line-soft);margin-top:4px;
  color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;}
.wb-git-commit-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.wb-git-hint{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;
  white-space:normal;overflow-wrap:anywhere;}
.wb-git-hint[data-tone='error']{color:var(--wb-git-err);}

/* banners, menus, dialogs, toast */
.wb-git-banner{display:flex;flex-direction:column;gap:2px;flex:0 0 auto;padding:8px 12px;
  border:1px solid var(--wb-git-line);border-radius:10px;background:var(--wb-git-card);
  color:var(--dsw-alias-label-secondary);font-size:11.5px;}
.wb-git-banner[data-tone='error']{color:var(--wb-git-err);}
.wb-git-banner-text{min-width:0;}
.wb-git-menu{position:absolute;right:6px;top:24px;z-index:5;min-width:150px;padding:5px;
  border:1px solid var(--wb-git-line);border-radius:10px;background:var(--wb-git-card);
  box-shadow:0 10px 26px var(--dsw-alias-bg-mask-1);}
.wb-git-menu button{display:block;width:100%;padding:5px 9px;border:0;border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.wb-git-menu button:hover{background:var(--wb-git-line-soft);}
.wb-git-menu button:disabled{color:var(--dsw-alias-label-caption);cursor:default;}
.wb-git-ctxmenu{position:fixed;z-index:80;min-width:200px;max-width:280px;padding:6px;
  border:1px solid var(--wb-git-line);border-radius:12px;background:var(--wb-git-card);
  box-shadow:0 12px 30px var(--dsw-alias-bg-mask-1);}
.wb-git-ctxmenu-title{padding:5px 9px 7px;margin-bottom:4px;border-bottom:1px solid var(--wb-git-line-soft);
  font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wb-git-ctxmenu-item{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;
  height:30px;padding:0 9px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;}
.wb-git-ctxmenu-item:hover:not(:disabled){background:var(--wb-git-accent-soft);}
.wb-git-ctxmenu-item:disabled{color:var(--dsw-alias-label-caption);cursor:default;}
.wb-git-ctxmenu-item[data-danger='true']:not(:disabled){color:var(--wb-git-err);}
.wb-git-ctxmenu-item kbd{font:10.5px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);}
.wb-git-ctxmenu-divider{height:1px;margin:5px 3px;background:var(--wb-git-line-soft);}
.wb-git-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-mask-1);}
.wb-git-dialog{width:340px;max-width:88vw;display:flex;flex-direction:column;gap:9px;padding:16px;
  border:1px solid var(--wb-git-line);border-radius:14px;background:var(--wb-git-card);
  box-shadow:0 18px 44px var(--dsw-alias-bg-mask-1);}
.wb-git-dialog-title{font-size:13.5px;font-weight:600;}
.wb-git-dialog-label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.wb-git-dialog-body{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);}
.wb-git-dialog-error{font-size:11px;color:var(--wb-git-err);}
.wb-git-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:5px;}
.wb-git-danger{background:var(--wb-git-err);color:var(--dsw-alias-label-primary-inverted);box-shadow:none;}
.wb-git-toast{pointer-events:auto;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;padding:8px 12px;
  border:1px solid var(--wb-git-line);border-radius:10px;background:var(--wb-git-card);
  color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 8px 24px var(--dsw-alias-bg-mask-1);}

/* Compact status surface; each pane owns its scrolling and commit never overlays code. */
.wb-git-root{container-type:inline-size;}
.wb-git-resize{display:flex;align-items:center;justify-content:center;flex:0 0 10px;cursor:col-resize;touch-action:none;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;outline:none;}
.wb-git-resize svg{pointer-events:none;}
.wb-git-resize:hover,.wb-git-resize:active,.wb-git-resize:focus-visible{color:var(--wb-git-accent);}
.wb-git-resize:focus-visible svg{background:var(--wb-git-accent-soft);border-radius:3px;}
.wb-git-list-tabs,.wb-git-file-tools,.wb-git-diff-tools{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding:6px;border-bottom:1px solid var(--wb-git-line-soft);flex-wrap:wrap;}
.wb-git-list-tabs{flex-wrap:nowrap;gap:0;}
.wb-workbench .wb-git-list-tabs .glab-tab{flex:1 1 0;min-width:0;justify-content:center;padding:7px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;}
.wb-git-file-scroll{flex:1;min-height:0;overflow:auto;padding:4px;}
.wb-git-directory-head{display:flex;align-items:center;justify-content:space-between;width:100%;height:28px;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;}
.wb-git-directory-head span{overflow:hidden;text-overflow:ellipsis;}
.wb-git-directory-head small{flex-shrink:0;color:var(--dsw-alias-label-tertiary);font-size:11px;}
.wb-git-branch-view{flex:1;min-width:0;overflow:auto;padding:12px;}
.wb-git-branch-view .wb-git-rail-ref{height:36px;}
.wb-git-diff-head .wb-git-diff-tools{min-width:0;max-width:100%;padding:4px 0;border:0;margin-left:auto;}
.wb-git-diff-path{flex:1 1 240px;white-space:normal;overflow-wrap:anywhere;}
.wb-git-commit{max-height:50%;overflow:auto;}
.wb-git-commit-label{flex-wrap:wrap;gap:6px;}
.wb-git-file-tools{flex-wrap:nowrap;}
.wb-git-file-tools .glab-btn{flex:none;}
@container (max-width:1000px){
  .wb-git-rail{flex-basis:130px;}
  .wb-git-list{flex-basis:240px;}
  .wb-git-refs{flex-wrap:wrap;}
  .wb-git-root .wb-git-topbar{height:auto;padding:5px 8px;flex-wrap:wrap;}
  .wb-git-upstream{max-width:none;}
}
@container (max-width:900px){
  .wb-git-body{flex-direction:column;overflow:auto;}
  .wb-git-body>.wb-git-rail{flex:0 0 auto;padding:4px;border-right:0;}
  .wb-git-rail-section{display:flex;gap:4px;}
  .wb-git-rail .wb-git-rail-title{display:none;}
  .wb-git-rail-row{width:auto;}
  .wb-git-body>.wb-git-resize{display:none;}
  .wb-git-main{flex:1 0 650px;}
  .wb-git-panes{flex-direction:column;}
  .wb-git-panes>.wb-git-resize{display:none;}
  .wb-git-list{flex:0 0 220px!important;border-right:0;border-bottom:1px solid var(--wb-git-line);}
  .wb-git-right{flex:1 0 420px;padding:0 6px;}
  .wb-git-right>.wb-git-topbar{margin:0 -6px;}
  .wb-git-commit{max-height:none;}
  .wb-git-ai{flex-wrap:wrap;}
  .wb-git-commit-meta{flex-wrap:wrap;}
}
@container (max-width:650px){.wb-git-root{padding:10px 16px 20px;}}
.wb-git-quick-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;}
.wb-git-commit-meta .wb-git-commit-toggle{margin-left:0;}
`
