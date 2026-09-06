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
var activestat;
var graphconf;
var activePage;
var static;
var active_rra;
var graph_drawn = false;

function Start() {
  static = getData('static')
  graphconf = getData('statistics')
    
  activestat = GetURLParameter('graph');
  if (activestat == null){
    activestat = localStorage.getItem('activestat') || 0;
  }
  activePage = GetURLParameter('activePage');
  if (activePage == null){ 
    activePage = 0; 
  }
  if ( ( typeof activePage == 'undefined' ) || 
       ( activePage >= graphconf.length ) 
     )
  { 
    activePage = 0 
  }
  if ( graphconf.length > 1 ) {
    $('#pageTitle').html("<h2>" + eval(graphconf[activePage].title) + "</h2><hr>" );
    $('#pageTitle').removeClass('hide');
  }

  FetchGraph();
}

function SetGraphlist() {
  var graphlist = "Graph: <select id='selected_graph'>\n";
  for (var iloop = 0; iloop < graphconf[activePage].content.length; iloop++) {
    graphlist += "<option value='" + iloop + "'";
    if (activestat == iloop) {
      graphlist += " selected ";
    }
    graphlist += ">" + eval(graphconf[activePage].content[iloop].title) + "</option>\n";
  }
  graphlist += "</select>\n";

  $("#mygraph_res_title").html(graphlist);
  
  $('#selected_graph').on('change', function (e) {
    activestat = this.value;
    localStorage.setItem('activestat', activestat);
    FetchGraph();
  });
}

function FetchGraph() {
  $('#preloader').removeClass('hide');
  if ( activestat >= graphconf[activePage].content.length ){
    activestat = 0;
    localStorage.setItem('activestat', activestat);
  }
  graph = graphconf[activePage].content[activestat].graph;
  for ( var iloop = 0; iloop < graph.length; iloop++) {
    if (  ( static==null ) || ( eval ( "static."+graph[iloop] ) ) ){
      try {
        FetchBinaryURLAsync('stat/empty.rrd', UpdateHandler, iloop);
      }
      catch (err) {
        alert("Failed loading stat/empty.rrd\n" + err);
      }
    }
    else {
      try {
        FetchBinaryURLAsync('stat/' + graph[iloop] + '.rrd', UpdateHandler, iloop);
      }
      catch (err) {
        alert("Failed loading stat/" + graph[iloop] + ".rrd\n" + err);
      }
    }
  }
}

function UpdateHandler(bf, idx) {
  graph = graphconf[activePage].content[activestat].graph;
  try {
    rrd_data[idx] = new RRDFile(bf);
  } catch (err) {
    alert("File stat/" + graph[idx] + ".rrd is not a valid RRD archive!");
  }
  PrepareGraph(idx);
  ready = 0;
  for (var iloop = 0; iloop < graph.length; iloop++) {
    if (rrd_data[iloop] != undefined) {
      ready++
    }
  }
  if (ready == graph.length) {
    UpdateGraph()
  }
}

function DoNothing(ds_name) {
  this.getName = function () {
    return ds_name;
  }
  this.getDSNames = function () {
    return [ds_name];
  }
  this.computeResult = function (val_list) {
    return val_list[0];
  }
}

function Zero(ds_name) { //create a fake DS.
  this.getName = function () {
    return ds_name;
  }
  this.getDSNames = function () {
    return [];
  }
  this.computeResult = function (val_list) {
    return 0;
  }
}

function SetValue(ds_name,value) { //create a fake DS.
  this.getName = function () {
    return ds_name;
  }
  this.getDSNames = function () {
    return [];
  }
  this.computeResult = function (val_list) {
    return value;
  }
}


function PrepareGraph(idx) {
  // http://javascriptrrd.sourceforge.net/docs/javascriptrrd_v0.6.0/src/examples/rrdJFlotFilter.html
  // http://sourceforge.net/p/javascriptrrd/discussion/914914/thread/935d8541/#17d3
  // Create a RRDFilterOp object that has the all DS's, with the one
  // existing in the original RRD populated with real values, and the other set to 0.
  graph = graphconf[activePage].content[activestat].graph;
  var op_list = []; //list of operations
  //create a new rrdlist, which contains all original elements (kept the same by DoNothing())
  for (var iloop = 0; iloop < graph.length; iloop++) {
    if (iloop != idx) {
      op_list.push(new Zero(graph[iloop]));
    }
    else {
      // If the graph should represent a static data, construct the line
      if ( rrd_data[idx].getDS(0).getName() == "empty" ) {
        op_list.push(new SetValue( graph[iloop], eval( "static."+graph[iloop] ) ) );
      }
      else {
        op_list.push(new DoNothing(rrd_data[idx].getDS(0).getName()));
      }
    }
  }
  rrd_data[idx] = new RRDFilterOp(rrd_data[idx], op_list);
}

// Flot 0.7 paints the grid, axes and legend onto a <canvas> from a plain
// JavaScript options object, so CSS cannot reach them. Build the theme
// derived defaults here and let the per KPI configuration override them.
//
// Flot 0.7 option names (confirmed in js/flot/jquery.flot.min.js):
//   grid.color            default "#545454", also seeds xaxis/yaxis color
//   grid.backgroundColor  canvas plot area fill
//   grid.borderColor      strokeRect around the plot area
//   grid.tickColor        seeds xaxis/yaxis tickColor
//   xaxis.color           written as an inline style="color:..." on the
//                         <div class="xAxis"> that wraps the tick labels,
//                         so this is the tick *label* colour
//   xaxis.tickColor       stroke colour of the grid tick lines; when null
//                         Flot derives it from xaxis.color at 22% alpha
//   legend.backgroundColor / legend.labelBoxBorderColor
// Flot 0.7 has no "font" option, tick labels are HTML not canvas text.
function ThemeGraphOptions() {
  var tok = ( typeof ThemeToken === 'function' ) ? ThemeToken : function () { return '' };
  var gridline = tok('--grid-line');
  var gridbg   = tok('--grid-bg');
  var line     = tok('--line');
  // --grid-label is Flot's axis tick label colour. It is a token of its own
  // rather than --txt-3 so that the light palette can keep Flot's historic
  // #545454 exactly; dark themes simply set it to their own --txt-3.
  var label    = tok('--grid-label') || tok('--txt-3');
  var bg1      = tok('--bg-1');

  var grid   = {};
  var xaxis  = {};
  var yaxis  = {};
  var legend = {};

  if ( gridline != '' ) {
    grid.color = gridline;
    grid.tickColor = gridline;
    xaxis.tickColor = gridline;
    yaxis.tickColor = gridline;
  }
  if ( gridbg != '' ) {
    grid.backgroundColor = gridbg;
  }
  if ( line != '' ) {
    grid.borderColor = line;
    legend.labelBoxBorderColor = line;
  }
  if ( label != '' ) {
    xaxis.color = label;
    yaxis.color = label;
  }
  else if ( gridline != '' ) {
    xaxis.color = gridline;
    yaxis.color = gridline;
  }
  if ( bg1 != '' ) {
    legend.backgroundColor = bg1;
  }

  var options = {};
  if ( !$.isEmptyObject(grid) )   { options.grid = grid; }
  if ( !$.isEmptyObject(xaxis) )  { options.xaxis = xaxis; }
  if ( !$.isEmptyObject(yaxis) )  { options.yaxis = yaxis; }
  if ( !$.isEmptyObject(legend) ) { options.legend = legend; }
  return options;
}

// Merge a configured value on top of a theme default. Plain objects are
// merged key by key so that a configuration setting for example
// yaxis={ position:"right" } keeps the theme colours it did not mention.
// Anything else simply replaces the default, so explicit configuration wins.
function MergeGraphOption(current, value) {
  if ( ( current != null ) && ( value != null ) &&
       ( $.isPlainObject(current) ) && ( $.isPlainObject(value) ) ) {
    for ( var key in value ) {
      current[key] = MergeGraphOption(current[key], value[key]);
    }
    return current;
  }
  return value;
}

function UpdateGraph() {
  // Seeded before the per KPI configuration is evaluated below so that
  // anything set in a .conf template still wins.
  graph_options=ThemeGraphOptions();
  active_rra=localStorage.getItem('active_rra') || 0;
  rrdflot_defaults={ graph_width:"750px",graph_height:"285px", scale_width:"350px", scale_height:"90px", use_rra:true, rra:active_rra };
  options = graphconf[activePage].content[activestat];
  ds_graph_options = options.ds_graph_options;

  for(var graph in ds_graph_options) {
    for(var param in ds_graph_options[graph]) {
      try {
        ds_graph_options[graph][param]=eval('(' + ds_graph_options[graph][param] + ')');
      }
      catch(e) {
      }
    }
  }
 
  if ( options.graph_options ) {
    for(var param in options.graph_options) {
      try {
        graph_options[param]=MergeGraphOption(graph_options[param], eval('(' + options.graph_options[param] + ')'));
      }
      catch(e) {
      }
    }
  }

  rrd_data_sum = new RRDFileSum( rrd_data );
  // The rrdFlot constructor empties #mygraph before rebuilding its layout
  // (rrdFlot.js: "while (base_el.lastChild!=null) base_el.removeChild(...)")
  // so calling UpdateGraph() again simply replaces the previous graph.
  var f = new rrdFlot("mygraph", rrd_data_sum, graph_options, ds_graph_options, rrdflot_defaults );
  SetGraphlist();
  graph_drawn = true;
  $('#preloader').addClass('hide');
  $('#Legend').addClass('hide');
}

function AddOption()
{
  options =
          '<p>'+
          '<b>Statistic</b><br>'+
          '<form class="form-inline">'+
            '<span>Default graph timeline <select class="span3" id="active_rra">'+
            '<option value="0" '+ ( active_rra == 0 ? 'selected' : '' ) +'>Graph n°1</option>'+
            '<option value="1" '+ ( active_rra == 1 ? 'selected' : '' ) +'>Graph n°2</option>'+
            '<option value="2" '+ ( active_rra == 2 ? 'selected' : '' ) +'>Graph n°3</option>'+
            '<option value="3" '+ ( active_rra == 3 ? 'selected' : '' ) +'>Graph n°4</option>'+
            '<option value="4" '+ ( active_rra == 4 ? 'selected' : '' ) +'>Graph n°5</option>'+
            '</select></span>'+
          '</form>'+
        '</p>'; 
  $(options).insertBefore("#optionsInsertionPoint")
}

$(function () {
  // Remove the Javascript warning
  document.getElementById("infotable").deleteRow(0);
  
  active_rra=(localStorage.getItem('active_rra') || 0);

  rrd_data = [];

  $.ajaxSetup({
    cache : false
  });

  ShowFriends();
  /* Add qrcode shortcut*/
  setupqr();
  doqr(document.URL);

  Start();
    
  /* Populate option dialog*/
  AddOption();
  
  $('#active_rra').change(function(){
    localStorage.setItem('active_rra',$('#active_rra').val())
    // TODO: Add text of mygraph_res selected option nearby graph selection
  });

  // The graph is painted to a canvas, so it has to be redrawn by hand when
  // the theme changes. Only once a first graph has been drawn, otherwise the
  // RRD files are not loaded yet.
  $(document).on('rpm:themechange', function(){
    if ( graph_drawn && ( typeof UpdateGraph === 'function' ) ) {
      UpdateGraph();
    }
  });

});
