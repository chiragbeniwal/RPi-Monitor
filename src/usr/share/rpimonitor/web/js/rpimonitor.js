// This file is part of RPi-Monitor project
//
// Copyright 2013 - Xavier Berger - http://rpi-experiences.blogspot.fr/
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
var animate;
var shellinaboxuri;
var statusautorefresh;
var refreshTimerId;
var clickId;
var current_path = window.location.pathname.split('/').pop();

// ---------------------------------------------------------------------------
// Theme management
//
// The preference stored in localStorage['rpm-theme'] can be any of the ids
// listed in RPM_THEMES (including 'auto'). The value written into the
// data-theme attribute of <html> is always a resolved theme ('auto' is never
// written). A small inline script at the top of each page applies the stored
// preference before the first paint to avoid a flash of the wrong theme.
// ---------------------------------------------------------------------------
var RPM_THEMES = [
  { id: 'auto',     name: 'Match system' },
  { id: 'light',    name: 'Light' },
  { id: 'graphite', name: 'Graphite (dark)' },
  { id: 'midnight', name: 'Midnight (dark)' },
  { id: 'slate',    name: 'Slate Soft (dark)' },
  { id: 'phosphor', name: 'Phosphor (terminal green)' }
];

// Light theme defaults used by ThemeToken() when the theme stylesheet could
// not be loaded. Without them SVG based widgets (JustGage) would be drawn
// with an empty colour and become invisible.
var RPM_THEME_FALLBACK = {
  '--bg-0'        : '#ffffff',
  '--bg-1'        : '#f5f5f5',
  '--bg-2'        : '#eeeeee',
  '--line'        : '#dddddd',
  '--txt-1'       : '#010101',
  '--txt-2'       : '#b3b3b3',
  '--txt-3'       : '#999999',
  '--txt-4'       : '#c0c0c0',
  '--acc-link'    : '#428bca',
  '--acc-ok'      : '#5cb85c',
  '--acc-warn'    : '#f0ad4e',
  '--acc-danger'  : '#d9534f',
  '--acc-info'    : '#5bc0de',
  '--bar-fill'    : '#428bca',
  '--bar-txt'     : '#ffffff',
  '--gauge-track' : '#edebeb',
  '--grid-line'   : '#cccccc',
  '--grid-bg'     : '#ffffff'
};

function GetThemePreference(){
  try {
    return localStorage.getItem('rpm-theme') || 'auto';
  }
  catch (e) {
    return 'auto';
  }
}

function GetDarkMediaQuery(){
  if ( window.matchMedia ) {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)');
    }
    catch (e) {
      return null;
    }
  }
  return null;
}

function ResolveTheme(pref){
  if ( pref != 'auto' ) {
    return pref;
  }
  var mql = GetDarkMediaQuery();
  if ( mql && mql.matches ) {
    return 'graphite';
  }
  return 'light';
}

function ApplyTheme(pref){
  pref = pref || 'auto';
  var resolved = ResolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  try {
    localStorage.setItem('rpm-theme', pref);
  }
  catch (e) {
    // localStorage throws in private browsing mode on old Safari.
  }
  $(document).trigger('rpm:themechange', [resolved]);
  return resolved;
}

function ThemeToken(name){
  var value = '';
  try {
    value = window.getComputedStyle(document.documentElement).getPropertyValue(name);
  }
  catch (e) {
    value = '';
  }
  value = value ? value.trim() : '';
  if ( value == '' ) {
    value = RPM_THEME_FALLBACK[name] || '';
  }
  return value;
}

function WatchSystemTheme(){
  var mql = GetDarkMediaQuery();
  if ( mql == null ) {
    return;
  }
  var handler = function(){
    if ( GetThemePreference() == 'auto' ) {
      ApplyTheme('auto');
    }
  };
  if ( mql.addEventListener ) {
    mql.addEventListener('change', handler);
  }
  else if ( mql.addListener ) {
    // Deprecated API, still the only one available on old WebKit.
    mql.addListener(handler);
  }
}

function AddThemeOption(){
  var pref = GetThemePreference();
  var options =
        '<p>'+
          '<b>Appearance</b><br>'+
          '<form class="form-inline">'+
            '<span>Theme <select class="span3" id="theme-select">';
  for ( var iloop=0; iloop < RPM_THEMES.length; iloop++){
    options +=
            '<option value="'+RPM_THEMES[iloop].id+'" '+ ( pref == RPM_THEMES[iloop].id ? 'selected' : '' ) +'>'+RPM_THEMES[iloop].name+'</option>';
  }
  options +=
            '</select></span>'+
          '</form>'+
        '</p>';
  $(options).insertBefore("#optionsInsertionPoint");
  $('#theme-select').on('change', function(){
    ApplyTheme($('#theme-select').val());
  });
}

function GetURLParameter(sParam)
{
    var sPageURL = window.location.search.substring(1);
    var sURLVariables = sPageURL.split('&');
    for (var i = 0; i < sURLVariables.length; i++)
    {
        var sParameterName = sURLVariables[i].split('=');
        if (sParameterName[0] == sParam)
        {
            return sParameterName[1];
        }
    }
}

function getData( name ){
  if ( localStorage.getItem(name+'Version') == localStorage.getItem('version') ) {
    return eval("(" + localStorage.getItem(name) + ')');
  }
  else
  {
    return $.ajax({
      url: name + '.json',
      dataType: 'json',
      async: false,
      success: function(data) {
        localStorage.setItem(name, JSON.stringify(data))
        localStorage.setItem(name+'Version', localStorage.getItem('version'))
        return data
      },
      fail: function () {
        $('#message').html("<b>Can not get information (<a href='"+name.json+"'>"+name+".json</a>) from RPi-Monitor server.</b>");
        $('#message').removeClass('hide');
        return null
      }
    }).responseJSON
  }
}

function ShowFriends(){
  var data = getData('friends')
  if ( data.length > 0 ) {
    $('#friends').empty();
    for (var i = 0; i < data.length; i++) {
      $('#friends').append('<li><a href="'+data[i].link+'">'+eval(data[i].title)+'</a></li>');
    }
    $('#divfriends').removeClass('hide');
  }
}

function AddFooter(){
$('#footer').html(
  '<div class="navbar-inverse navbar-fixed-bottom text-center">'+
    '<small>'+
      '<a href="http://rpi-experiences.blogspot.fr/">RPi-Experiences</a>'+
      '<span class="rpm-sep"> | </span>'+
      '<a href="https://github.com/XavierBerger/RPi-Monitor">GitHub</a>'+
      '<span class="rpm-sep"> | </span>'+
      '<a href="http://www.raspberrypi.org/">Raspberry Pi Foundation</a>'+
    '</small>'+
  '</div>'
);
}

function AddDialogs(){
  var dialogs="";

  // Add Options Dialog
  dialogs+=
    '<div id="Options" class="modal fade">'+
      '<div class="modal-dialog">' +
        '<div class="modal-content">'+
      '<div class="modal-header">'+
      '<button type="button" class="close" data-dismiss="modal"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button>' +
      '<h4 id="myModalLabel">Options</h4>'+
      '</div>'+
      '<div class="modal-body">'+
         '<i id="optionsInsertionPoint"></i>'+
      '</div>'+
      '<div class="modal-footer">'+
      '<button class="btn" data-dismiss="modal" aria-hidden="true" id="closeoptions">Close</button>'+
      '</div>'+
      '</div>'+
    '</div>'+
    '</div>';

  // Add License Dialog
  dialogs+=
    '<div id="License" class="modal fade">'+
      '<div class="modal-dialog">' +
        '<div class="modal-content">'+
      '<div class="modal-header">'+
      '<button type="button" class="close" data-dismiss="modal"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button>' +
      '<h4 id="myModalLabel">License</h4>'+
      '</div>'+
      '<div class="modal-body">'+
      'This program is free software: you can redistribute it and/or modify '+
      ' of the GNU General Public License as published '+
      'by the Free Software Foundation, either version 3 of the License, or '+
      '(at your option) any later version.<br>'+
      '<br>'+
      'This program is distributed in the hope that it will be useful, but '+
      'WITHOUT ANY WARRANTY; without even the implied warranty of '+
      'MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. '+
      'See the GNU General Public License for more details.<br>'+
      '<br>'+
      'You should have received a copy of the GNU General Public License '+
      'along with this program. If not, see <a href="http://www.gnu.org/licenses/">http://www.gnu.org/licenses/</a>.'+
      '</p>'+
      '<hr>'+
      '<b>RPi-Monitor</b> is using third party software that have their own licenses. '+
      'Refer to <a href="#About" data-dismiss="modal" data-toggle="modal">About</a> to view the list of software used by <b>RPi-Monitor</b>. '+
      '</div>'+
      '<div class="modal-footer">'+
      '<button class="btn" data-dismiss="modal" aria-hidden="true">Close</button>'+
      '</div>'+
      '</div>'+
    '</div>'+
    '</div>';

  // Add About Dialog
  dialogs+=
    '<div id="About" class="modal fade">'+
      '<div class="modal-dialog">' +
        '<div class="modal-content">'+
      '<div class="modal-header">'+
      '<button type="button" class="close" data-dismiss="modal"><span aria-hidden="true">&times;</span><span class="sr-only">Close</span></button>' +
      '<h4 id="myModalLabel">About</h4>'+
      '</div>'+
      '<div class="modal-body">'+
      '<p><b>Version</b>: {DEVELOPMENT} '+
      '<b>by</b> Xavier Berger</p>'+
      'With the contribution of users sharing ideas and competences on Github.'+
      '<br>'+
      '<a href="http://rpi-experiences.blogspot.fr/">Blog</a>'+' - '+
      '<a href="https://github.com/XavierBerger/RPi-Monitor">GitHub</a>'+' - '+
      '<a href="https://xavierberger.github.io/RPi-Monitor-docs/index.html">Documentation</a>'+
      '<hr>'+
      '<p><b>RPi-Monitor</b> is free software developed on top of other open source '+
        'tools: <a href="http://twitter.github.io/bootstrap/">bootstrap</a>, <a href="http://jquery.com/">jquery</a>, <a href="https://code.google.com/p/jsqrencode/">jsqrencode</a>, <a href="http://javascriptrrd.sourceforge.net/">javascriptrrd</a> and <a href="http://www.flotcharts.org/">Flot</a>.<br>'+
      '<p><b>Raspberry Pi</b> and the Raspberry Pi logo are properties of <a href="http://www.raspberrypi.org/">Raspberry Pi Foundation</a>.</p>'+
      '</div>'+
      '<div class="modal-footer">'+
      '<button class="btn" data-dismiss="modal" aria-hidden="true">Close</button>'+
      '</div>'+
      '</div>'+
    '</div>'+
    '</div>';

  $('#dialogs').html(dialogs);
}

function AddTopmenu(){
  page = getData('page')
  data = getData('static')
  try {
    document.title = eval(page.pagetitle);
  }
  catch (err) {
    document.title=page.pagetitle;
  }
  try {
    icon = eval(page.icon);
  }
  catch (err) {
    icon=page.icon;
  }
  try {
    menutitle = eval(page.menutitle);
  }
  catch (err) {
    menutitle=page.menutitle;
  }
  topmenu=
    '<nav class="navbar navbar-inverse navbar-fixed-top" role="navigation">' +
    '<div class="container-fluid">' +
    '<div class="navbar-header">' +
      '<button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#bs-example-navbar-collapse-1">' +
      '<span class="sr-only">Toggle navigation</span>' +
      '<span class="icon-bar"></span>' +
      '<span class="icon-bar"></span>' +
      '<span class="icon-bar"></span>' +
      '</button>' +
      '<a class="navbar-brand" href="index.html"><img height="20" src="'+icon+'"> &nbsp;'+menutitle+'</a>' +
    '</div>' +
    '<div class="collapse navbar-collapse" id="bs-example-navbar-collapse-1">' +
      '<ul class="nav navbar-nav">' +
        '<li id="statusmenu"><a id="statuslink" href="status.html">Status</a></li>'+
            '<li id="statisticsmenu"><a id="statisticslink" href="statistics.html">Statistics</a></li>'+
            '<li id="addonsmenu" class="hide"><a id="addonslink" href="addons.html">Add-ons</a></li>'+
            '<li id="optionsmenu"><a href="#Options" data-toggle="modal">Options</a></li>'+
            '<li class="dropdown">' +
        '<a href="#" class="dropdown-toggle" data-toggle="dropdown">About <span class="caret"></span></a>' +
        '<ul class="dropdown-menu" role="menu">' +
        '<li class="dropdown-header"> <b>RPi-Monitor</b></li>'+
        '<li><a href="#" title="Scan this qrcode to reach this page from your smartphone or tablet"><canvas id="qrcanv"><a></li>'+
        '<li><a href="#License" data-toggle="modal">License</a></li>'+
        '<li><a href="#About" data-toggle="modal">About</a></li>'+
        '<li class="divider"></li>'+
        '<li class="dropdown-header"> <b>Related links</b></li>'+
        '<li><a href="https://xavierberger.github.io/RPi-Monitor-docs/index.html" data-toggle="modal">Documentation</a></li>'+
        '<li><a href="http://rpi-experiences.blogspot.fr/">RPi-Experiences</a></li>'+
        '<li><a href="https://github.com/XavierBerger/RPi-Monitor">RPi-Monitor on GitHub</a></li>'+
        '</ul>' +
      '</li>' +
      '</ul>' +
      '<div class="pull-right hide" id="divfriends">'+
        '<ul class="nav navbar-nav">'+
        '<li class="dropdown">'+
          '<a href="#" class="dropdown-toggle" data-toggle="dropdown">Friends <b class="caret"></b></a>'+
          '<ul class="dropdown-menu dropdown-menu-right" id="friends">'+
          '</ul>'+
        '</li>'+
        '</ul>'+
      '</div>'+
    '</div><!-- /.navbar-collapse -->' +
    '</div><!-- /.container-fluid -->' +
  '</nav>'
  $('#topmenu').html(topmenu);
}

function UpdateMenu(){
  // Disable index page
  //var index=true;
  var index=false;

  // Manage active link
  if (current_path == 'status.html'){
    $('#statusmenu').addClass('active');
    index=false;
  }
  else if (current_path == 'statistics.html'){
    $('#statisticsmenu').addClass('active');
    index=false;
  }
  else if (current_path == 'addons.html'){
    $('#addonsmenu').addClass('active');
    index=false;
  }

  // On home page, the menu is not shown
  if ( index==true ) {
    $('#statusmenu').addClass('hide');
    $('#statisticsmenu').addClass('hide');
    $('#addonsmenu').addClass('hide');
    $('#optionsmenu').addClass('hide');
    return;
  }

  var data = getData('menu');
  if ( data.status == undefined ) {
    $('#statusmenu').addClass('hide');
  }
  else{
  if ( data.status.length > 1 ){
    $('#statusmenu').addClass('dropdown');
    var dropDownMenu='<ul class="dropdown-menu">';
    for ( var iloop=0; iloop < data.status.length; iloop++){
      dropDownMenu+='<li><a href="status.html?activePage='+iloop+'">'+eval(data.status[iloop])+'</a></li>';
    }
    dropDownMenu+='</ul>';
    $('#statuslink').html( 'Status <b class="caret"></b>')
    $(dropDownMenu).insertAfter('#statuslink');
    $('#statuslink').addClass('dropdown-toggle');
    $('#statuslink').attr('data-toggle','dropdown');
    $('#statuslink').attr('href','#');
  }
  }

  if ( data.statistics == undefined ) {
    $('#statisticsmenu').addClass('hide');
  }
  else {
  if ( data.statistics.length > 1 ){
    $('#statisticsmenu').addClass('dropdown');
    var dropDownMenu='<ul class="dropdown-menu">';
    for ( var iloop=0; iloop < data.statistics.length; iloop++){
      dropDownMenu+='<li><a href="statistics.html?activePage='+iloop+'">'+eval(data.statistics[iloop])+'</a></li>';
    }
    dropDownMenu+='</ul>';
    $('#statisticslink').html( 'Statistics <b class="caret"></b>')
    $(dropDownMenu).insertAfter('#statisticslink');
    $('#statisticslink').addClass('dropdown-toggle');
    $('#statisticslink').attr('data-toggle','dropdown');
    $('#statisticslink').attr('href','#');
    }
  }

  if ( data.addons != undefined ) {
    if ( data.addons.length > 0 ){
      $('#addonsmenu').removeClass('hide');
      $('#addonslink').html(eval(data.addons[0]));
    }
    if ( data.addons.length > 1 ){
      $('#addonsmenu').addClass('dropdown');
      var dropDownMenu='<ul class="dropdown-menu">';
      for ( var iloop=0; iloop < data.addons.length; iloop++){
        dropDownMenu+='<li><a href="addons.html?activePage='+iloop+'">'+eval(data.addons[iloop])+'</a></li>';
      }
      dropDownMenu+='</ul>';
      $('#addonslink').html( 'Add-ons <b class="caret"></b>')
      $(dropDownMenu).insertAfter('#addonslink');
      $('#addonslink').addClass('dropdown-toggle');
      $('#addonslink').attr('data-toggle','dropdown');
      $('#addonslink').attr('href','#');
    }
  }
}

function getVersion(){
  $.ajax({
    url: 'version.json',
    dataType: 'json',
    async: false,
    success: function(data) {
        localStorage.setItem('version', data.version);
      }
    })
}

$(function () {

  if ( localStorage == null ) {
    alert ("TypeError: localStorage is null\n\n" +
           "Activate HTML5 localStorage before continuing."
          );
  }

  // Construct the page template
  // The inline script of the page has normally already set data-theme before
  // the first paint. Set it here too so the theme still applies if it did not.
  if ( !document.documentElement.getAttribute('data-theme') ) {
    document.documentElement.setAttribute('data-theme', ResolveTheme(GetThemePreference()));
  }
  WatchSystemTheme();

  getVersion();
  AddTopmenu();
  AddDialogs();
  AddThemeOption();
  AddFooter();
  UpdateMenu();

});
